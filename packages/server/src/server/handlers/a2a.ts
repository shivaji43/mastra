import { A2AError } from '@mastra/core/a2a';
import type { TaskSendParams, TaskQueryParams, TaskIdParams, AgentCard, TaskStatus, TaskState } from '@mastra/core/a2a';
import type { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { RuntimeContext } from '@mastra/core/runtime-context';
import { z } from 'zod';
import { convertToCoreMessage, normalizeError, createSuccessResponse, createErrorResponse } from '../a2a/protocol';
import { InMemoryTaskStore } from '../a2a/store';
import { applyUpdateToTaskAndHistory, createTaskContext, loadOrCreateTaskAndHistory } from '../a2a/tasks';
import type { Context } from '../types';

const taskSendParamsSchema = z.object({
  id: z.string().min(1, 'Invalid or missing task ID (params.id).'),
  message: z.object({
    parts: z.array(
      z.object({
        type: z.enum(['text']),
        text: z.string(),
      }),
    ),
  }),
});

export async function getAgentCardByIdHandler({
  mastra,
  agentId,
  executionUrl = `/a2a/${agentId}`,
  provider = {
    organization: 'Mastra',
    url: 'https://mastra.ai',
  },
  version = '1.0',
  runtimeContext,
}: Context & {
  runtimeContext: RuntimeContext;
  agentId: keyof ReturnType<typeof mastra.getAgents>;
  executionUrl?: string;
  version?: string;
  provider?: {
    organization: string;
    url: string;
  };
}): Promise<AgentCard> {
  const agent = mastra.getAgent(agentId);

  if (!agent) {
    throw new Error(`Agent with ID ${agentId} not found`);
  }

  const [instructions, tools] = await Promise.all([
    agent.getInstructions({ runtimeContext }),
    agent.getTools({ runtimeContext }),
  ]);

  // Extract agent information to create the AgentCard
  const agentCard: AgentCard = {
    name: agent.id || agentId,
    description: instructions,
    url: executionUrl,
    provider,
    version,
    capabilities: {
      streaming: true, // All agents support streaming
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    // Convert agent tools to skills format for A2A protocol
    skills: Object.entries(tools).map(([toolId, tool]) => ({
      id: toolId,
      name: toolId,
      description: tool.description || `Tool: ${toolId}`,
      // Optional fields
      tags: ['tool'],
    })),
  };

  return agentCard;
}

function validateTaskSendParams(params: TaskSendParams) {
  try {
    taskSendParamsSchema.parse(params);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw A2AError.invalidParams((error as z.ZodError).errors[0]!.message);
    }

    throw error;
  }
}

export async function handleTaskSend({
  requestId,
  params,
  taskStore,
  agent,
  agentId,
  logger,
  runtimeContext,
}: {
  requestId: string;
  params: TaskSendParams;
  taskStore: InMemoryTaskStore;
  agent: Agent;
  agentId: string;
  logger?: IMastraLogger;
  runtimeContext: RuntimeContext;
}) {
  validateTaskSendParams(params);

  const { id: taskId, message, sessionId, metadata } = params;

  // Load or create task AND history
  let currentData = await loadOrCreateTaskAndHistory({
    taskId,
    taskStore,
    agentId,
    message,
    sessionId,
    metadata,
  });

  // Use the new TaskContext definition, passing history
  const context = createTaskContext({
    task: currentData.task,
    userMessage: message,
    history: currentData.history,
    activeCancellations: taskStore.activeCancellations,
  });

  try {
    const { text } = await agent.generate([convertToCoreMessage(message)], {
      runId: taskId,
      runtimeContext,
    });

    currentData = applyUpdateToTaskAndHistory(currentData, {
      state: 'completed',
      message: {
        role: 'agent',
        parts: [
          {
            type: 'text',
            text: text,
          },
        ],
      },
    });

    await taskStore.save({ agentId, data: currentData });
    context.task = currentData.task;
  } catch (handlerError) {
    // If handler throws, apply 'failed' status, save, and rethrow
    const failureStatusUpdate: Omit<TaskStatus, 'timestamp'> = {
      state: 'failed',
      message: {
        role: 'agent',
        parts: [
          {
            type: 'text',
            text: `Handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
          },
        ],
      },
    };
    currentData = applyUpdateToTaskAndHistory(currentData, failureStatusUpdate);

    try {
      await taskStore.save({ agentId, data: currentData });
    } catch (saveError) {
      // @ts-expect-error saveError is an unknown error
      logger?.error(`Failed to save task ${taskId} after handler error:`, saveError?.message);
    }

    return normalizeError(handlerError, requestId, taskId, logger); // Rethrow original error
  }

  // The loop finished, send the final task state
  return createSuccessResponse(requestId, currentData.task);
}

export async function handleTaskGet({
  requestId,
  taskStore,
  agentId,
  taskId,
}: {
  requestId: string;
  taskStore: InMemoryTaskStore;
  agentId: string;
  taskId: string;
}) {
  const task = await taskStore.load({ agentId, taskId });

  if (!task) {
    throw A2AError.taskNotFound(taskId);
  }

  return createSuccessResponse(requestId, task);
}

export async function* handleTaskSendSubscribe({
  requestId,
  params,
  taskStore,
  agent,
  agentId,
  logger,
  runtimeContext,
}: {
  requestId: string;
  params: TaskSendParams;
  taskStore: InMemoryTaskStore;
  agent: Agent;
  agentId: string;
  logger?: IMastraLogger;
  runtimeContext: RuntimeContext;
}) {
  yield createSuccessResponse(requestId, {
    state: 'working',
    message: {
      role: 'agent',
      parts: [{ type: 'text', text: 'Generating response...' }],
    },
  });

  let result;
  try {
    result = await handleTaskSend({
      requestId,
      params,
      taskStore,
      agent,
      agentId,
      runtimeContext,
      logger,
    });
  } catch (err) {
    if (!(err instanceof A2AError)) {
      throw err;
    }

    result = createErrorResponse(requestId, err.toJSONRPCError());
  }

  yield result;
}

export async function handleTaskCancel({
  requestId,
  taskStore,
  agentId,
  taskId,
  logger,
}: {
  requestId: string;
  taskStore: InMemoryTaskStore;
  agentId: string;
  taskId: string;
  logger?: IMastraLogger;
}) {
  // Load task and history
  let data = await taskStore.load({
    agentId,
    taskId,
  });

  if (!data) {
    throw A2AError.taskNotFound(taskId);
  }

  // Check if cancelable (not already in a final state)
  const finalStates: TaskState[] = ['completed', 'failed', 'canceled'];

  if (finalStates.includes(data.task.status.state)) {
    logger?.info(`Task ${taskId} already in final state ${data.task.status.state}, cannot cancel.`);
    return createSuccessResponse(requestId, data.task);
  }

  // Signal cancellation
  taskStore.activeCancellations.add(taskId);

  // Apply 'canceled' state update
  const cancelUpdate: Omit<TaskStatus, 'timestamp'> = {
    state: 'canceled',
    message: {
      role: 'agent',
      parts: [{ type: 'text', text: 'Task cancelled by request.' }],
    },
  };

  data = applyUpdateToTaskAndHistory(data, cancelUpdate);

  // Save the updated state
  await taskStore.save({ agentId, data });

  // Remove from active cancellations *after* saving
  taskStore.activeCancellations.delete(taskId);

  // Return the updated task object
  return createSuccessResponse(requestId, data.task);
}

export async function getAgentExecutionHandler({
  requestId,
  mastra,
  agentId,
  runtimeContext,
  method,
  params,
  taskStore = new InMemoryTaskStore(),
  logger,
}: Context & {
  requestId: string;
  runtimeContext: RuntimeContext;
  agentId: string;
  method: 'tasks/send' | 'tasks/sendSubscribe' | 'tasks/get' | 'tasks/cancel';
  params: TaskSendParams | TaskQueryParams | TaskIdParams;
  taskStore?: InMemoryTaskStore;
  logger?: IMastraLogger;
}): Promise<any> {
  const agent = mastra.getAgent(agentId);

  let taskId: string | undefined; // For error context

  try {
    // Attempt to get task ID early for error context. Cast params to any to access id.
    // Proper validation happens within specific handlers.
    taskId = params.id;

    // 2. Route based on method
    switch (method) {
      case 'tasks/send': {
        const result = await handleTaskSend({
          requestId,
          params: params as TaskSendParams,
          taskStore,
          agent,
          agentId,
          runtimeContext,
        });
        return result;
      }
      case 'tasks/sendSubscribe':
        const result = await handleTaskSendSubscribe({
          requestId,
          taskStore,
          params: params as TaskSendParams,
          agent,
          agentId,
          runtimeContext,
        });
        return result;

      case 'tasks/get': {
        const result = await handleTaskGet({
          requestId,
          taskStore,
          agentId,
          taskId,
        });

        return result;
      }
      case 'tasks/cancel': {
        const result = await handleTaskCancel({
          requestId,
          taskStore,
          agentId,
          taskId,
        });

        return result;
      }
      default:
        throw A2AError.methodNotFound(method);
    }
  } catch (error) {
    if (error instanceof A2AError && taskId && !error.taskId) {
      error.taskId = taskId; // Add task ID context if missing
    }

    return normalizeError(error, requestId, taskId, logger);
  }
}
