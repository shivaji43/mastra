import type { Mastra } from '@mastra/core';
import {
  getMemoryStatusHandler as getOriginalMemoryStatusHandler,
  getThreadsHandler as getOriginalThreadsHandler,
  getThreadByIdHandler as getOriginalThreadByIdHandler,
  saveMessagesHandler as getOriginalSaveMessagesHandler,
  createThreadHandler as getOriginalCreateThreadHandler,
  updateThreadHandler as getOriginalUpdateThreadHandler,
  deleteThreadHandler as getOriginalDeleteThreadHandler,
  getMessagesHandler as getOriginalGetMessagesHandler,
} from '@mastra/server/handlers/memory';
import type { Context } from 'hono';

import { handleError } from './error';

// Memory handlers
export async function getMemoryStatusHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const networkId = c.req.query('networkId');

    const result = await getOriginalMemoryStatusHandler({
      mastra,
      agentId,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error getting memory status');
  }
}

export async function getThreadsHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const resourceId = c.req.query('resourceid');
    const networkId = c.req.query('networkId');

    const result = await getOriginalThreadsHandler({
      mastra,
      agentId,
      resourceId,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error getting threads');
  }
}

export async function getThreadByIdHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const threadId = c.req.param('threadId');
    const networkId = c.req.query('networkId');

    const result = await getOriginalThreadByIdHandler({
      mastra,
      agentId,
      threadId,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error getting thread');
  }
}

export async function saveMessagesHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const networkId = c.req.query('networkId');
    const body = await c.req.json();

    const result = await getOriginalSaveMessagesHandler({
      mastra,
      agentId,
      body,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error saving messages');
  }
}

export async function createThreadHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const networkId = c.req.query('networkId');
    const body = await c.req.json();

    const result = await getOriginalCreateThreadHandler({
      mastra,
      agentId,
      body,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error saving thread to memory');
  }
}

export async function updateThreadHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const threadId = c.req.param('threadId');
    const networkId = c.req.query('networkId');
    const body = await c.req.json();

    const result = await getOriginalUpdateThreadHandler({
      mastra,
      agentId,
      threadId,
      body,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error updating thread');
  }
}

export async function deleteThreadHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const threadId = c.req.param('threadId');
    const networkId = c.req.query('networkId');

    const result = await getOriginalDeleteThreadHandler({
      mastra,
      agentId,
      threadId,
      networkId,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error deleting thread');
  }
}

export async function getMessagesHandler(c: Context) {
  try {
    const mastra: Mastra = c.get('mastra');
    const agentId = c.req.query('agentId');
    const networkId = c.req.query('networkId');
    const threadId = c.req.param('threadId');
    const rawLimit = c.req.query('limit');
    let limit: number | undefined = undefined;

    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
        limit = n;
      }
    }

    const result = await getOriginalGetMessagesHandler({
      mastra,
      agentId,
      threadId,
      networkId,
      limit,
    });

    return c.json(result);
  } catch (error) {
    return handleError(error, 'Error getting messages');
  }
}
