import type { MetricResult, TestInfo } from '@mastra/core/eval';
import type { StorageThreadType, MastraMessageV1, MastraMessageV2 } from '@mastra/core/memory';
import {
  MastraStorage,
  TABLE_MESSAGES,
  TABLE_THREADS,
  TABLE_WORKFLOW_SNAPSHOT,
  TABLE_EVALS,
  TABLE_TRACES,
} from '@mastra/core/storage';
import type {
  TABLE_NAMES,
  StorageColumn,
  StorageGetMessagesArg,
  EvalRow,
  WorkflowRuns,
  WorkflowRun,
} from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { Redis } from '@upstash/redis';
import { MessageList } from '../../../../packages/core/dist/agent/index.cjs';

export interface UpstashConfig {
  url: string;
  token: string;
}

export class UpstashStore extends MastraStorage {
  private redis: Redis;

  constructor(config: UpstashConfig) {
    super({ name: 'Upstash' });
    this.redis = new Redis({
      url: config.url,
      token: config.token,
    });
  }

  private transformEvalRecord(record: Record<string, any>): EvalRow {
    // Parse JSON strings if needed
    let result = record.result;
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {
        console.warn('Failed to parse result JSON:');
      }
    }

    let testInfo = record.test_info;
    if (typeof testInfo === 'string') {
      try {
        testInfo = JSON.parse(testInfo);
      } catch {
        console.warn('Failed to parse test_info JSON:');
      }
    }

    return {
      agentName: record.agent_name,
      input: record.input,
      output: record.output,
      result: result as MetricResult,
      metricName: record.metric_name,
      instructions: record.instructions,
      testInfo: testInfo as TestInfo | undefined,
      globalRunId: record.global_run_id,
      runId: record.run_id,
      createdAt:
        typeof record.created_at === 'string'
          ? record.created_at
          : record.created_at instanceof Date
            ? record.created_at.toISOString()
            : new Date().toISOString(),
    };
  }

  private parseJSON(value: any): any {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  private getKey(tableName: TABLE_NAMES, keys: Record<string, any>): string {
    const keyParts = Object.entries(keys)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}:${value}`);
    return `${tableName}:${keyParts.join(':')}`;
  }

  private ensureDate(date: Date | string | undefined): Date | undefined {
    if (!date) return undefined;
    return date instanceof Date ? date : new Date(date);
  }

  private serializeDate(date: Date | string | undefined): string | undefined {
    if (!date) return undefined;
    const dateObj = this.ensureDate(date);
    return dateObj?.toISOString();
  }

  /**
   * Scans for keys matching the given pattern using SCAN and returns them as an array.
   * @param pattern Redis key pattern, e.g. "table:*"
   * @param batchSize Number of keys to scan per batch (default: 1000)
   */
  private async scanKeys(pattern: string, batchSize = 10000): Promise<string[]> {
    let cursor = '0';
    let keys: string[] = [];
    do {
      // Upstash: scan(cursor, { match, count })
      const [nextCursor, batch] = await this.redis.scan(cursor, {
        match: pattern,
        count: batchSize,
      });
      keys.push(...batch);
      cursor = nextCursor;
    } while (cursor !== '0');
    return keys;
  }

  /**
   * Deletes all keys matching the given pattern using SCAN and DEL in batches.
   * @param pattern Redis key pattern, e.g. "table:*"
   * @param batchSize Number of keys to delete per batch (default: 1000)
   */
  private async scanAndDelete(pattern: string, batchSize = 10000): Promise<number> {
    let cursor = '0';
    let totalDeleted = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, {
        match: pattern,
        count: batchSize,
      });
      if (keys.length > 0) {
        await this.redis.del(...keys);
        totalDeleted += keys.length;
      }
      cursor = nextCursor;
    } while (cursor !== '0');
    return totalDeleted;
  }

  private getMessageKey(threadId: string, messageId: string): string {
    return this.getKey(TABLE_MESSAGES, { threadId, id: messageId });
  }

  private getThreadMessagesKey(threadId: string): string {
    return `thread:${threadId}:messages`;
  }

  private parseWorkflowRun(row: any): WorkflowRun {
    let parsedSnapshot: WorkflowRunState | string = row.snapshot as string;
    if (typeof parsedSnapshot === 'string') {
      try {
        parsedSnapshot = JSON.parse(row.snapshot as string) as WorkflowRunState;
      } catch (e) {
        // If parsing fails, return the raw snapshot string
        console.warn(`Failed to parse snapshot for workflow ${row.workflow_name}: ${e}`);
      }
    }

    return {
      workflowName: row.workflow_name,
      runId: row.run_id,
      snapshot: parsedSnapshot,
      createdAt: this.ensureDate(row.createdAt)!,
      updatedAt: this.ensureDate(row.updatedAt)!,
      resourceId: row.resourceId,
    };
  }

  private processRecord(tableName: TABLE_NAMES, record: Record<string, any>) {
    let key: string;

    if (tableName === TABLE_MESSAGES) {
      // For messages, use threadId as the primary key component
      key = this.getKey(tableName, { threadId: record.threadId, id: record.id });
    } else if (tableName === TABLE_WORKFLOW_SNAPSHOT) {
      key = this.getKey(tableName, {
        namespace: record.namespace || 'workflows',
        workflow_name: record.workflow_name,
        run_id: record.run_id,
        ...(record.resourceId ? { resourceId: record.resourceId } : {}),
      });
    } else if (tableName === TABLE_EVALS) {
      key = this.getKey(tableName, { id: record.run_id });
    } else {
      key = this.getKey(tableName, { id: record.id });
    }

    // Convert dates to ISO strings before storing
    const processedRecord = {
      ...record,
      createdAt: this.serializeDate(record.createdAt),
      updatedAt: this.serializeDate(record.updatedAt),
    };

    return { key, processedRecord };
  }

  async getEvalsByAgentName(agentName: string, type?: 'test' | 'live'): Promise<EvalRow[]> {
    try {
      // Get all keys that match the evals table pattern
      const pattern = `${TABLE_EVALS}:*`;
      const keys = await this.scanKeys(pattern);

      // Fetch all eval records
      const evalRecords = await Promise.all(
        keys.map(async key => {
          const data = await this.redis.get<Record<string, any>>(key);
          return data;
        }),
      );

      // Filter by agent name and remove nulls
      const nonNullRecords = evalRecords.filter(
        (record): record is Record<string, any> =>
          record !== null && typeof record === 'object' && 'agent_name' in record && record.agent_name === agentName,
      );

      // Apply additional filtering based on type
      let filteredEvals = nonNullRecords;

      if (type === 'test') {
        filteredEvals = filteredEvals.filter(record => {
          if (!record.test_info) return false;

          // Handle test_info as a JSON string
          try {
            if (typeof record.test_info === 'string') {
              const parsedTestInfo = JSON.parse(record.test_info);
              return parsedTestInfo && typeof parsedTestInfo === 'object' && 'testPath' in parsedTestInfo;
            }

            // Handle test_info as an object
            return typeof record.test_info === 'object' && 'testPath' in record.test_info;
          } catch {
            return false;
          }
        });
      } else if (type === 'live') {
        filteredEvals = filteredEvals.filter(record => {
          if (!record.test_info) return true;

          // Handle test_info as a JSON string
          try {
            if (typeof record.test_info === 'string') {
              const parsedTestInfo = JSON.parse(record.test_info);
              return !(parsedTestInfo && typeof parsedTestInfo === 'object' && 'testPath' in parsedTestInfo);
            }

            // Handle test_info as an object
            return !(typeof record.test_info === 'object' && 'testPath' in record.test_info);
          } catch {
            return true;
          }
        });
      }

      // Transform to EvalRow format
      return filteredEvals.map(record => this.transformEvalRecord(record));
    } catch (error) {
      console.error('Failed to get evals for the specified agent:', error);
      return [];
    }
  }

  async getTraces(
    {
      name,
      scope,
      page = 0,
      perPage = 100,
      attributes,
      filters,
      fromDate,
      toDate,
    }: {
      name?: string;
      scope?: string;
      page: number;
      perPage: number;
      attributes?: Record<string, string>;
      filters?: Record<string, any>;
      fromDate?: Date;
      toDate?: Date;
    } = {
      page: 0,
      perPage: 100,
    },
  ): Promise<any[]> {
    try {
      // Get all keys that match the traces table pattern
      const pattern = `${TABLE_TRACES}:*`;
      const keys = await this.scanKeys(pattern);

      // Fetch all trace records
      const traceRecords = await Promise.all(
        keys.map(async key => {
          const data = await this.redis.get<Record<string, any>>(key);
          return data;
        }),
      );

      // Filter out nulls and apply filters
      let filteredTraces = traceRecords.filter(
        (record): record is Record<string, any> => record !== null && typeof record === 'object',
      );

      // Apply name filter if provided
      if (name) {
        filteredTraces = filteredTraces.filter(record => record.name?.toLowerCase().startsWith(name.toLowerCase()));
      }

      // Apply scope filter if provided
      if (scope) {
        filteredTraces = filteredTraces.filter(record => record.scope === scope);
      }

      // Apply attributes filter if provided
      if (attributes) {
        filteredTraces = filteredTraces.filter(record => {
          const recordAttributes = record.attributes;
          if (!recordAttributes) return false;

          // Parse attributes if stored as string
          const parsedAttributes =
            typeof recordAttributes === 'string' ? JSON.parse(recordAttributes) : recordAttributes;

          return Object.entries(attributes).every(([key, value]) => parsedAttributes[key] === value);
        });
      }

      // Apply custom filters if provided
      if (filters) {
        filteredTraces = filteredTraces.filter(record =>
          Object.entries(filters).every(([key, value]) => record[key] === value),
        );
      }

      // Apply fromDate filter if provided
      if (fromDate) {
        filteredTraces = filteredTraces.filter(
          record => new Date(record.createdAt).getTime() >= new Date(fromDate).getTime(),
        );
      }

      // Apply toDate filter if provided
      if (toDate) {
        filteredTraces = filteredTraces.filter(
          record => new Date(record.createdAt).getTime() <= new Date(toDate).getTime(),
        );
      }

      // Sort traces by creation date (newest first)
      filteredTraces.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Apply pagination
      const start = page * perPage;
      const end = start + perPage;
      const paginatedTraces = filteredTraces.slice(start, end);

      // Transform and return the traces
      return paginatedTraces.map(record => ({
        id: record.id,
        parentSpanId: record.parentSpanId,
        traceId: record.traceId,
        name: record.name,
        scope: record.scope,
        kind: record.kind,
        status: this.parseJSON(record.status),
        events: this.parseJSON(record.events),
        links: this.parseJSON(record.links),
        attributes: this.parseJSON(record.attributes),
        startTime: record.startTime,
        endTime: record.endTime,
        other: this.parseJSON(record.other),
        createdAt: this.ensureDate(record.createdAt),
      }));
    } catch (error) {
      console.error('Failed to get traces:', error);
      return [];
    }
  }

  async createTable({
    tableName,
    schema,
  }: {
    tableName: TABLE_NAMES;
    schema: Record<string, StorageColumn>;
  }): Promise<void> {
    // Redis is schemaless, so we don't need to create tables
    // But we can store the schema for reference
    await this.redis.set(`schema:${tableName}`, schema);
  }

  async clearTable({ tableName }: { tableName: TABLE_NAMES }): Promise<void> {
    const pattern = `${tableName}:*`;
    await this.scanAndDelete(pattern);
  }

  async insert({ tableName, record }: { tableName: TABLE_NAMES; record: Record<string, any> }): Promise<void> {
    const { key, processedRecord } = this.processRecord(tableName, record);

    await this.redis.set(key, processedRecord);
  }

  async batchInsert(input: { tableName: TABLE_NAMES; records: Record<string, any>[] }): Promise<void> {
    const { tableName, records } = input;
    if (!records.length) return;

    const batchSize = 1000;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const pipeline = this.redis.pipeline();
      for (const record of batch) {
        const { key, processedRecord } = this.processRecord(tableName, record);
        pipeline.set(key, processedRecord);
      }
      await pipeline.exec();
    }
  }

  async load<R>({ tableName, keys }: { tableName: TABLE_NAMES; keys: Record<string, string> }): Promise<R | null> {
    const key = this.getKey(tableName, keys);
    const data = await this.redis.get<R>(key);
    return data || null;
  }

  async getThreadById({ threadId }: { threadId: string }): Promise<StorageThreadType | null> {
    const thread = await this.load<StorageThreadType>({
      tableName: TABLE_THREADS,
      keys: { id: threadId },
    });

    if (!thread) return null;

    return {
      ...thread,
      createdAt: this.ensureDate(thread.createdAt)!,
      updatedAt: this.ensureDate(thread.updatedAt)!,
      metadata: typeof thread.metadata === 'string' ? JSON.parse(thread.metadata) : thread.metadata,
    };
  }

  async getThreadsByResourceId({ resourceId }: { resourceId: string }): Promise<StorageThreadType[]> {
    const pattern = `${TABLE_THREADS}:*`;
    const keys = await this.scanKeys(pattern);
    const threads = await Promise.all(
      keys.map(async key => {
        const data = await this.redis.get<StorageThreadType>(key);
        return data;
      }),
    );

    return threads
      .filter(thread => thread && thread.resourceId === resourceId)
      .map(thread => ({
        ...thread!,
        createdAt: this.ensureDate(thread!.createdAt)!,
        updatedAt: this.ensureDate(thread!.updatedAt)!,
        metadata: typeof thread!.metadata === 'string' ? JSON.parse(thread!.metadata) : thread!.metadata,
      }));
  }

  async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    await this.insert({
      tableName: TABLE_THREADS,
      record: thread,
    });
    return thread;
  }

  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const thread = await this.getThreadById({ threadId: id });
    if (!thread) {
      throw new Error(`Thread ${id} not found`);
    }

    const updatedThread = {
      ...thread,
      title,
      metadata: {
        ...thread.metadata,
        ...metadata,
      },
    };

    await this.saveThread({ thread: updatedThread });
    return updatedThread;
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    const key = this.getKey(TABLE_THREADS, { id: threadId });
    await this.redis.del(key);
  }

  async saveMessages(args: { messages: MastraMessageV1[]; format?: undefined | 'v1' }): Promise<MastraMessageV1[]>;
  async saveMessages(args: { messages: MastraMessageV2[]; format: 'v2' }): Promise<MastraMessageV2[]>;
  async saveMessages(
    args: { messages: MastraMessageV1[]; format?: undefined | 'v1' } | { messages: MastraMessageV2[]; format: 'v2' },
  ): Promise<MastraMessageV2[] | MastraMessageV1[]> {
    const { messages, format = 'v1' } = args;
    if (messages.length === 0) return [];

    // Add an index to each message to maintain order
    const messagesWithIndex = messages.map((message, index) => ({
      ...message,
      _index: index,
    }));

    const batchSize = 1000;
    for (let i = 0; i < messagesWithIndex.length; i += batchSize) {
      const batch = messagesWithIndex.slice(i, i + batchSize);
      const pipeline = this.redis.pipeline();
      for (const message of batch) {
        const key = this.getMessageKey(message.threadId!, message.id);
        const score = message._index !== undefined ? message._index : new Date(message.createdAt).getTime();

        // Store the message data
        pipeline.set(key, message);

        // Add to sorted set for this thread
        pipeline.zadd(this.getThreadMessagesKey(message.threadId!), {
          score,
          member: message.id,
        });
      }

      await pipeline.exec();
    }

    const list = new MessageList().add(messages, 'memory');
    if (format === `v2`) return list.get.all.v2();
    return list.get.all.v1();
  }

  public async getMessages(args: StorageGetMessagesArg & { format?: 'v1' }): Promise<MastraMessageV1[]>;
  public async getMessages(args: StorageGetMessagesArg & { format: 'v2' }): Promise<MastraMessageV2[]>;
  public async getMessages({
    threadId,
    selectBy,
    format,
  }: StorageGetMessagesArg & { format?: 'v1' | 'v2' }): Promise<MastraMessageV1[] | MastraMessageV2[]> {
    const limit = typeof selectBy?.last === `number` ? selectBy.last : 40;
    const messageIds = new Set<string>();
    const threadMessagesKey = this.getThreadMessagesKey(threadId);

    if (limit === 0 && !selectBy?.include) {
      return [];
    }

    // First, get specifically included messages and their context
    if (selectBy?.include?.length) {
      for (const item of selectBy.include) {
        messageIds.add(item.id);

        if (item.withPreviousMessages || item.withNextMessages) {
          // Get the rank of this message in the sorted set
          const rank = await this.redis.zrank(threadMessagesKey, item.id);
          if (rank === null) continue;

          // Get previous messages if requested
          if (item.withPreviousMessages) {
            const start = Math.max(0, rank - item.withPreviousMessages);
            const prevIds = rank === 0 ? [] : await this.redis.zrange(threadMessagesKey, start, rank - 1);
            prevIds.forEach(id => messageIds.add(id as string));
          }

          // Get next messages if requested
          if (item.withNextMessages) {
            const nextIds = await this.redis.zrange(threadMessagesKey, rank + 1, rank + item.withNextMessages);
            nextIds.forEach(id => messageIds.add(id as string));
          }
        }
      }
    }

    // Then get the most recent messages
    const latestIds = limit === 0 ? [] : await this.redis.zrange(threadMessagesKey, -limit, -1);
    latestIds.forEach(id => messageIds.add(id as string));

    // Fetch all needed messages in parallel
    const messages = (
      await Promise.all(
        Array.from(messageIds).map(async id =>
          this.redis.get<MastraMessageV2 & { _index?: number }>(this.getMessageKey(threadId, id)),
        ),
      )
    ).filter(msg => msg !== null) as (MastraMessageV2 & { _index?: number })[];

    // Sort messages by their position in the sorted set
    const messageOrder = await this.redis.zrange(threadMessagesKey, 0, -1);
    messages.sort((a, b) => messageOrder.indexOf(a!.id) - messageOrder.indexOf(b!.id));

    // Remove _index before returning
    const prepared = messages.map(({ _index, ...message }) => message as unknown as MastraMessageV1);

    const list = new MessageList().add(prepared, 'memory');
    if (format === `v2`) return list.get.all.v2();
    return list.get.all.v1();
  }

  async persistWorkflowSnapshot(params: {
    namespace: string;
    workflowName: string;
    runId: string;
    snapshot: WorkflowRunState;
  }): Promise<void> {
    const { namespace = 'workflows', workflowName, runId, snapshot } = params;
    await this.insert({
      tableName: TABLE_WORKFLOW_SNAPSHOT,
      record: {
        namespace,
        workflow_name: workflowName,
        run_id: runId,
        snapshot,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  async loadWorkflowSnapshot(params: {
    namespace: string;
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    const { namespace = 'workflows', workflowName, runId } = params;
    const key = this.getKey(TABLE_WORKFLOW_SNAPSHOT, {
      namespace,
      workflow_name: workflowName,
      run_id: runId,
    });
    const data = await this.redis.get<{
      namespace: string;
      workflow_name: string;
      run_id: string;
      snapshot: WorkflowRunState;
    }>(key);
    if (!data) return null;
    return data.snapshot;
  }

  async getWorkflowRuns(
    {
      namespace,
      workflowName,
      fromDate,
      toDate,
      limit,
      offset,
      resourceId,
    }: {
      namespace: string;
      workflowName?: string;
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
      resourceId?: string;
    } = { namespace: 'workflows' },
  ): Promise<WorkflowRuns> {
    try {
      // Get all workflow keys
      let pattern = this.getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace }) + ':*';
      if (workflowName && resourceId) {
        pattern = this.getKey(TABLE_WORKFLOW_SNAPSHOT, {
          namespace,
          workflow_name: workflowName,
          run_id: '*',
          resourceId,
        });
      } else if (workflowName) {
        pattern = this.getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace, workflow_name: workflowName }) + ':*';
      } else if (resourceId) {
        pattern = this.getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace, workflow_name: '*', run_id: '*', resourceId });
      }
      const keys = await this.scanKeys(pattern);

      // Get all workflow data
      const workflows = await Promise.all(
        keys.map(async key => {
          const data = await this.redis.get<{
            workflow_name: string;
            run_id: string;
            snapshot: WorkflowRunState | string;
            createdAt: string | Date;
            updatedAt: string | Date;
            resourceId: string;
          }>(key);
          return data;
        }),
      );

      // Filter and transform results
      let runs = workflows
        .filter(w => w !== null)
        .map(w => this.parseWorkflowRun(w!))
        .filter(w => {
          if (fromDate && w.createdAt < fromDate) return false;
          if (toDate && w.createdAt > toDate) return false;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const total = runs.length;

      // Apply pagination if requested
      if (limit !== undefined && offset !== undefined) {
        runs = runs.slice(offset, offset + limit);
      }

      return { runs, total };
    } catch (error) {
      console.error('Error getting workflow runs:', error);
      throw error;
    }
  }

  async getWorkflowRunById({
    namespace = 'workflows',
    runId,
    workflowName,
  }: {
    namespace: string;
    runId: string;
    workflowName?: string;
  }): Promise<WorkflowRun | null> {
    try {
      const key = this.getKey(TABLE_WORKFLOW_SNAPSHOT, { namespace, workflow_name: workflowName, run_id: runId }) + '*';
      const keys = await this.scanKeys(key);
      const workflows = await Promise.all(
        keys.map(async key => {
          const data = await this.redis.get<{
            workflow_name: string;
            run_id: string;
            snapshot: WorkflowRunState | string;
            createdAt: string | Date;
            updatedAt: string | Date;
            resourceId: string;
          }>(key);
          return data;
        }),
      );
      const data = workflows.find(w => w?.run_id === runId && w?.workflow_name === workflowName) as WorkflowRun | null;
      if (!data) return null;
      return this.parseWorkflowRun(data);
    } catch (error) {
      console.error('Error getting workflow run by ID:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    // No explicit cleanup needed for Upstash Redis
  }
}
