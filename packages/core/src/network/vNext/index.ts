import { randomUUID } from 'crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Mastra, MastraMessageV2, Tool } from '../..';
import { Agent } from '../../agent';
import type { DynamicArgument, MastraLanguageModel } from '../../agent';
import { MastraBase } from '../../base';
import { RegisteredLogger } from '../../logger';
import type { MastraMemory } from '../../memory';
import { RuntimeContext } from '../../runtime-context';
import type { Workflow } from '../../workflows';
import { EMITTER_SYMBOL } from '../../workflows/constants';
import { createWorkflow, createStep } from '../../workflows/workflow';

interface NewAgentNetworkConfig {
  id: string;
  name: string;
  instructions: DynamicArgument<string>;
  model: DynamicArgument<MastraLanguageModel>;
  agents: DynamicArgument<Record<string, Agent>>;
  workflows?: DynamicArgument<Record<string, Workflow>>;
  tools?: DynamicArgument<Record<string, Tool<any, any, any>>>;
  memory?: DynamicArgument<MastraMemory>;
  defaultAgent?: DynamicArgument<Agent>;
}

const RESOURCE_TYPES = z.enum(['agent', 'workflow', 'none', 'tool', 'none']);

// getInstructions() {

//     return `

//             ## Available Specialized Agents
//             You can call these agents using the "transmit" tool:
//             ${agentList}

//             ## How to Use the "transmit" Tool

//             The "transmit" tool allows you to call one or more specialized agents.

//             ### Single Agent Call
//             To call a single agent, use this format:
//             \`\`\`json
//             {
//               "actions": [
//                 {
//                   "agent": "agent_name",
//                   "input": "detailed instructions for the agent"
//                 }
//               ]
//             }
//             \`\`\`

//             ### Multiple Parallel Agent Calls
//             To call multiple agents in parallel, use this format:
//             \`\`\`json
//             {
//               "actions": [
//                 {
//                   "agent": "first_agent_name",
//                   "input": "detailed instructions for the first agent"
//                 },
//                 {
//                   "agent": "second_agent_name",
//                   "input": "detailed instructions for the second agent"
//                 }
//               ]
//             }
//             \`\`\`

//             ## Context Sharing

//             When calling an agent, you can choose to include the output from previous agents in the context.
//             This allows the agent to take into account the results from previous steps.

//             To include context, add the "includeHistory" field to the action and set it to true:
//             \`\`\`json
//             {
//               "actions": [
//                 {
//                   "agent": "agent_name",
//                   "input": "detailed instructions for the agent",
//                   "includeHistory": true
//                 }
//               ]
//             }
//             \`\`\`

//             ## Best Practices
//             1. Break down complex tasks into smaller steps
//             2. Choose the most appropriate agent for each step
//             3. Provide clear, detailed instructions to each agent
//             4. Synthesize the results from multiple agents when needed
//             5. Provide a final summary or answer to the user

//             ## Workflow
//             1. Analyze the user's request
//             2. Identify which specialized agent(s) can help
//             3. Call the appropriate agent(s) using the transmit tool
//             4. Review the agent's response
//             5. Either call more agents or provide a final answer
//         `;
// }

export class NewAgentNetwork extends MastraBase {
  id: string;
  name: string;
  #instructions: DynamicArgument<string>;
  #model: DynamicArgument<MastraLanguageModel>;
  #agents: DynamicArgument<Record<string, Agent>>;
  #defaultAgent: DynamicArgument<Agent> | undefined;
  #workflows: DynamicArgument<Record<string, Workflow>> | undefined;
  #tools: DynamicArgument<Record<string, Tool>> | undefined;
  #memory?: DynamicArgument<MastraMemory>;
  #mastra?: Mastra;

  constructor({
    id,
    name,
    instructions,
    model,
    agents,
    workflows,
    memory,
    tools,
    defaultAgent,
  }: NewAgentNetworkConfig) {
    super({
      component: RegisteredLogger.NETWORK,
      name: name || 'NewAgentNetwork',
    });

    this.id = id;
    this.name = name;
    this.#instructions = instructions;
    this.#model = model;
    this.#agents = agents;
    this.#workflows = workflows;
    this.#memory = memory;
    this.#tools = tools;
    this.#defaultAgent = defaultAgent;
  }

  __registerMastra(mastra: Mastra) {
    this.#mastra = mastra;
  }

  async getAgents({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    let agentsToUse: Record<string, Agent>;

    if (typeof this.#agents === 'function') {
      agentsToUse = await this.#agents({ runtimeContext: runtimeContext || new RuntimeContext() });
    } else {
      agentsToUse = this.#agents;
    }

    return agentsToUse;
  }

  async getWorkflows({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    let workflowsToUse: Record<string, Workflow>;

    if (typeof this.#workflows === 'function') {
      workflowsToUse = await this.#workflows({ runtimeContext: runtimeContext || new RuntimeContext() });
    } else {
      workflowsToUse = this.#workflows || {};
    }

    return workflowsToUse;
  }

  async getTools({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    let toolsToUse: Record<string, Tool>;

    if (typeof this.#tools === 'function') {
      toolsToUse = await this.#tools({ runtimeContext: runtimeContext || new RuntimeContext() });
    } else {
      toolsToUse = this.#tools || {};
    }

    return toolsToUse;
  }

  async getMemory({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    let memoryToUse: MastraMemory;

    if (!this.#memory) {
      return;
    }

    if (typeof this.#memory === 'function') {
      memoryToUse = await this.#memory({ runtimeContext: runtimeContext || new RuntimeContext() });
    } else {
      memoryToUse = this.#memory;
    }

    return memoryToUse;
  }

  async getInstructions({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    let instructionsToUse = this.#instructions;

    if (typeof instructionsToUse === 'function') {
      instructionsToUse = await instructionsToUse({ runtimeContext: runtimeContext || new RuntimeContext() });
    }

    return instructionsToUse;
  }

  async getRoutingAgent({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    const instructionsToUse = await this.getInstructions({ runtimeContext: runtimeContext || new RuntimeContext() });
    const memoryToUse = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
    const agentsToUse = await this.getAgents({ runtimeContext: runtimeContext || new RuntimeContext() });
    const workflowsToUse = await this.getWorkflows({ runtimeContext: runtimeContext || new RuntimeContext() });
    const toolsToUse = await this.getTools({ runtimeContext: runtimeContext || new RuntimeContext() });

    const agentList = Object.entries(agentsToUse)
      .map(([name, agent]) => {
        // Use agent name instead of description since description might not exist
        return ` - **${name}**: ${agent.getDescription()}`;
      })
      .join('\n');

    const workflowList = Object.entries(workflowsToUse)
      .map(([name, workflow]) => {
        return ` - **${name}**: ${workflow.description}, input schema: ${JSON.stringify(
          zodToJsonSchema(workflow.inputSchema),
        )}`;
      })
      .join('\n');

    const toolList = Object.entries(toolsToUse)
      .map(([name, tool]) => {
        return ` - **${name}**: ${tool.description}, input schema: ${JSON.stringify(
          zodToJsonSchema(tool.inputSchema || z.object({})),
        )}`;
      })
      .join('\n');

    const instructions = `
          You are a router in a network of specialized AI agents. 
          Your job is to decide which agent should handle each step of a task.

          If asking for completion of a task, make sure to follow system instructions closely.
            
          ## System Instructions
          ${instructionsToUse}

          You can only pick agents and workflows that are available in the lists below. Never call any agents or workflows that are not available in the lists below.

          ## Available Agents in Network
          ${agentList}

          ## Available Workflows in Network (make sure to use inputs corresponding to the input schema when calling a workflow)
          ${workflowList}

          ## Available Tools in Network (make sure to use inputs corresponding to the input schema when calling a tool)
          ${toolList}

          ${
            this.#defaultAgent
              ? `If none of the agents or workflows are appropriate, call the default agent: ${this.#defaultAgent.name}.` +
                `This should not be done lightly. You should only do this if you have exhausted all other options.`
              : ''
          }

          If you have multiple entries that need to be called with a workflow or agent, call them separately with each input.
          When calling a workflow, the prompt should be a JSON value that corresponds to the input schema of the workflow. The JSON value is stringified.
          When calling a tool, the prompt should be a JSON value that corresponds to the input schema of the tool. The JSON value is stringified.
          When calling an agent, the prompt should be a text value, like you would call an LLM in a chat interface.

          Keep in mind that the user only sees the final result of the task. When reviewing completion, you should know that the user will not see the intermediate results.
        `;

    return new Agent({
      name: 'routing-agent',
      instructions,
      model: this.#model,
      memory: memoryToUse,
    });
  }

  async loop(
    message: string,
    {
      runtimeContext,
      maxIterations,
    }: {
      runtimeContext?: RuntimeContext;
      maxIterations?: number;
    },
  ) {
    const networkWorkflow = this.createWorkflow({ runtimeContext });

    const finalStep = createStep({
      id: 'final-step',
      inputSchema: networkWorkflow.outputSchema,
      outputSchema: networkWorkflow.outputSchema,
      execute: async ({ inputData }) => {
        if (maxIterations && inputData.iteration >= maxIterations) {
          return {
            ...inputData,
            completionReason: `Max iterations reached: ${maxIterations}`,
          };
        }

        return inputData;
      },
    });

    const mainWorkflow = createWorkflow({
      id: 'Agent-Network-Main-Workflow',
      inputSchema: z.object({
        iteration: z.number(),
        task: z.string(),
        resourceType: RESOURCE_TYPES,
      }),
      outputSchema: z.object({
        text: z.string(),
        iteration: z.number(),
      }),
    })
      .dountil(networkWorkflow, async ({ inputData }) => {
        return inputData.isComplete || (maxIterations && inputData.iteration >= maxIterations);
      })
      .then(finalStep)
      .commit();

    const run = mainWorkflow.createRun();

    const result = await run.start({
      inputData: {
        task: message,
        resourceType: 'none',
        iteration: 0,
      },
    });

    if (result.status === 'failed') {
      throw result.error;
    }

    if (result.status === 'suspended') {
      throw new Error('Workflow suspended');
    }

    return result;
  }

  async loopStream(
    message: string,
    {
      runtimeContext,
      maxIterations,
      threadId,
      resourceId,
    }: {
      runtimeContext?: RuntimeContext;
      maxIterations?: number;
      threadId?: string;
      resourceId?: string;
    },
  ) {
    const networkWorkflow = this.createWorkflow({ runtimeContext });

    const finalStep = createStep({
      id: 'final-step',
      inputSchema: networkWorkflow.outputSchema,
      outputSchema: networkWorkflow.outputSchema,
      execute: async ({ inputData }) => {
        if (maxIterations && inputData.iteration >= maxIterations) {
          return {
            ...inputData,
            completionReason: `Max iterations reached: ${maxIterations}`,
          };
        }

        return inputData;
      },
    });

    const mainWorkflow = createWorkflow({
      id: 'Agent-Network-Main-Workflow',
      inputSchema: z.object({
        iteration: z.number(),
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        result: z.string().optional(),
        threadId: z.string().optional(),
        threadResourceId: z.string().optional(),
        isOneOff: z.boolean(),
      }),
      outputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        completionReason: z.string().optional(),
        iteration: z.number(),
      }),
    })
      .dountil(networkWorkflow, async ({ inputData }) => {
        return inputData.isComplete || (maxIterations && inputData.iteration >= maxIterations);
      })
      .then(finalStep)
      .commit();

    const run = mainWorkflow.createRun();

    const memory = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
    await memory?.saveMessages({
      messages: [
        {
          id: randomUUID() as string,
          type: 'text',
          role: 'user',
          content: { parts: [{ type: 'text', text: message }], format: 2 },
          createdAt: new Date(),
          threadId: threadId || run.runId,
          resourceId: resourceId || this.name,
        },
      ] as MastraMessageV2[],
      format: 'v2',
    });

    return run.stream({
      inputData: {
        task: message,
        resourceId: '',
        resourceType: 'none',
        iteration: 0,
        threadResourceId: resourceId,
        threadId,
        isOneOff: false,
      },
    });
  }

  createWorkflow({ runtimeContext }: { runtimeContext?: RuntimeContext }) {
    const runId = randomUUID();

    const runtimeContextToUse = runtimeContext || new RuntimeContext();

    const routingStep = createStep({
      id: 'routing-step',
      inputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        result: z.string().optional(),
        iteration: z.number(),
        threadId: z.string().optional(),
        threadResourceId: z.string().optional(),
        isOneOff: z.boolean(),
      }),
      outputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        selectionReason: z.string(),
        iteration: z.number(),
      }),
      execute: async ({ inputData, getInitData }) => {
        const initData = await getInitData();

        const routingAgent = await this.getRoutingAgent({ runtimeContext: runtimeContextToUse });

        let completionResult;
        if (inputData.resourceType !== 'none' && inputData?.result) {
          // Check if the task is complete
          const completionPrompt = `
                        The ${inputData.resourceType} ${inputData.resourceId} has contributed to the task.
                        This is the result from the agent: ${inputData.result}

                        You need to evaluate that our task is complete. Pay very close attention to the SYSTEM INSTRUCTIONS for when the task is considered complete. Only return true if the task is complete according to the system instructions. Pay close attention to the finalResult and completionReason.
                        Original task: ${inputData.task}

                        {
                            "isComplete": boolean,
                            "completionReason": string,
                            "finalResult": string
                        }
                    `;

          completionResult = await routingAgent.generate([{ role: 'assistant', content: completionPrompt }], {
            output: z.object({
              isComplete: z.boolean(),
              finalResult: z.string(),
              completionReason: z.string(),
            }),
            threadId: initData?.threadId ?? runId,
            resourceId: initData?.threadResourceId ?? this.name,
          });

          if (completionResult.object.isComplete) {
            return {
              task: inputData.task,
              resourceId: '',
              resourceType: 'none' as z.infer<typeof RESOURCE_TYPES>,
              prompt: '',
              result: completionResult.object.finalResult,
              isComplete: true,
              selectionReason: completionResult.object.completionReason,
              iteration: inputData.iteration + 1,
            };
          }
        }

        const result = await routingAgent.generate(
          [
            {
              role: 'assistant',
              content: `
                    ${inputData.isOneOff ? 'You are executing just one primitive based on the user task' : 'You will be calling just *one* primitive at a time to accomplish the user task'}

                    The user has given you the following task: 
                    ${inputData.task}
                    ${completionResult ? `\n\n${completionResult.object.finalResult}` : ''}

                    Please select the most appropriate primitive to handle this task and the prompt to be sent to the primitive.
                    If you are calling the same agent again, make sure to adjust the prompt to be more specific.

                    {
                        "resourceId": string,
                        "resourceType": "agent" | "workflow" | "tool",
                        "prompt": string,
                        "selectionReason": string
                    }
                    `,
            },
          ],
          {
            output: z.object({
              resourceId: z.string(),
              resourceType: RESOURCE_TYPES,
              prompt: z.string(),
              selectionReason: z.string(),
            }),
            threadId: initData?.threadId ?? runId,
            resourceId: initData?.threadResourceId ?? this.name,
          },
        );

        return {
          task: inputData.task,
          result: '',
          resourceId: result.object.resourceId,
          resourceType: result.object.resourceType,
          prompt: result.object.prompt,
          isComplete: result.object.resourceId === 'none' && result.object.resourceType === 'none' ? true : false,
          selectionReason: result.object.selectionReason,
          iteration: inputData.iteration + 1,
        };
      },
    });

    const agentStep = createStep({
      id: 'agent-step',
      inputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        selectionReason: z.string(),
        iteration: z.number(),
      }),
      outputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        result: z.string(),
        isComplete: z.boolean().optional(),
        iteration: z.number(),
      }),
      execute: async ({ inputData, [EMITTER_SYMBOL]: emitter, getInitData }) => {
        const agentsMap = await this.getAgents({ runtimeContext: runtimeContextToUse });
        const agentId = inputData.resourceId;

        const agent = agentsMap[inputData.resourceId];

        if (!agent) {
          throw new Error(`Agent ${agentId} not found`);
        }

        let streamPromise = {} as {
          promise: Promise<string>;
          resolve: (value: string) => void;
          reject: (reason?: any) => void;
        };

        streamPromise.promise = new Promise((resolve, reject) => {
          streamPromise.resolve = resolve;
          streamPromise.reject = reject;
        });
        const toolData = {
          name: agent.name,
          args: inputData,
        };
        await emitter.emit('watch-v2', {
          type: 'tool-call-streaming-start',
          ...toolData,
        });
        const { fullStream } = await agent.stream(inputData.prompt, {
          // resourceId: inputData.resourceId,
          // threadId: inputData.threadId,
          onFinish: result => {
            streamPromise.resolve(result.text);
          },
        });

        for await (const chunk of fullStream) {
          switch (chunk.type) {
            case 'text-delta':
              await emitter.emit('watch-v2', {
                type: 'tool-call-delta',
                ...toolData,
                argsTextDelta: chunk.textDelta,
              });
              break;

            case 'step-start':
            case 'step-finish':
            case 'finish':
            case 'tool-call':
            case 'tool-result':
            case 'tool-call-streaming-start':
            case 'tool-call-delta':
              break;
            case 'source':
            case 'file':
            default:
              await emitter.emit('watch-v2', chunk);
              break;
          }
        }

        const finalResult = await streamPromise.promise;

        const memory = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
        const initData = await getInitData();
        await memory?.saveMessages({
          messages: [
            {
              id: randomUUID() as string,
              type: 'text',
              role: 'assistant',
              content: { parts: [{ type: 'text', text: finalResult }], format: 2 },
              createdAt: new Date(),
              threadId: initData.threadId || runId,
              resourceId: initData.threadResourceId || this.name,
            },
          ] as MastraMessageV2[],
          format: 'v2',
        });

        return {
          task: inputData.task,
          resourceId: inputData.resourceId,
          resourceType: inputData.resourceType,
          result: finalResult,
          isComplete: false,
          iteration: inputData.iteration,
        };
      },
    });

    const workflowStep = createStep({
      id: 'workflow-step',
      inputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        selectionReason: z.string(),
        iteration: z.number(),
      }),
      outputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        result: z.string(),
        isComplete: z.boolean().optional(),
        iteration: z.number(),
      }),
      execute: async ({ inputData, [EMITTER_SYMBOL]: emitter, getInitData }) => {
        const workflowsMap = await this.getWorkflows({ runtimeContext: runtimeContextToUse });
        const wf = workflowsMap[inputData.resourceId];

        if (!wf) {
          throw new Error(`Workflow ${inputData.resourceId} not found`);
        }

        let input;
        try {
          input = JSON.parse(inputData.prompt);
        } catch (e: unknown) {
          console.error(e);
          throw new Error(`Invalid task input: ${inputData.task}`);
        }

        let streamPromise = {} as {
          promise: Promise<any>;
          resolve: (value: any) => void;
          reject: (reason?: any) => void;
        };

        streamPromise.promise = new Promise((resolve, reject) => {
          streamPromise.resolve = resolve;
          streamPromise.reject = reject;
        });
        const toolData = {
          name: wf.name,
          args: inputData,
        };
        await emitter.emit('watch-v2', {
          type: 'tool-call-streaming-start',
          ...toolData,
        });
        const run = wf.createRun();
        const { stream, getWorkflowState } = run.stream({
          inputData: input,
          runtimeContext: runtimeContextToUse,
        });

        let result: any;
        let stepResults: Record<string, any> = {};
        for await (const chunk of stream) {
          const c: any = chunk;
          // const c = chunk;
          switch (c.type) {
            case 'text-delta':
              await emitter.emit('watch-v2', {
                type: 'tool-call-delta',
                ...toolData,
                argsTextDelta: c.textDelta,
              });
              break;

            case 'step-result':
              if (c?.payload?.output) {
                result = c?.payload?.output;
                stepResults[c?.payload?.id] = c?.payload?.output;
              }
              await emitter.emit('watch-v2', c);
              break;
            case 'finish':
              streamPromise.resolve(result);
              break;

            case 'start':
            case 'finish':
            case 'step-start':
            case 'step-finish':
            case 'tool-call':
            case 'tool-result':
            case 'tool-call-streaming-start':
            case 'tool-call-delta':
            case 'source':
            case 'file':
            default:
              await emitter.emit('watch-v2', c);
              break;
          }
        }

        let runSuccess = true;
        const runResult = await streamPromise.promise;

        const workflowState = await getWorkflowState();
        if (workflowState.status === 'failed') {
          runSuccess = false;
        }

        const finalResult = JSON.stringify({
          runId: run.runId,
          runResult,
          runSuccess,
        });

        const memory = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
        const initData = await getInitData();
        await memory?.saveMessages({
          messages: [
            {
              id: randomUUID() as string,
              type: 'text',
              role: 'assistant',
              content: { parts: [{ type: 'text', text: finalResult }], format: 2 },
              createdAt: new Date(),
              threadId: initData.threadId || runId,
              resourceId: initData.threadResourceId || this.name,
            },
          ] as MastraMessageV2[],
          format: 'v2',
        });

        return {
          result: finalResult || '',
          task: inputData.task,
          resourceId: inputData.resourceId,
          resourceType: inputData.resourceType,
          isComplete: false,
          iteration: inputData.iteration,
        };
      },
    });

    const toolStep = createStep({
      id: 'toolStep',
      inputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        selectionReason: z.string(),
        iteration: z.number(),
      }),
      outputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        result: z.string(),
        isComplete: z.boolean().optional(),
        iteration: z.number(),
      }),
      execute: async ({ inputData, getInitData }) => {
        const toolsMap = await this.getTools({ runtimeContext: runtimeContextToUse });
        const tool = toolsMap[inputData.resourceId];

        if (!tool) {
          throw new Error(`Tool ${inputData.resourceId} not found`);
        }

        if (!tool.execute) {
          throw new Error(`Tool ${inputData.resourceId} does not have an execute function`);
        }

        let inputDataToUse: any;
        try {
          inputDataToUse = JSON.parse(inputData.prompt);
        } catch (e: unknown) {
          console.error(e);
          throw new Error(`Invalid task input: ${inputData.task}`);
        }

        const finalResult: any = await tool.execute({
          runtimeContext: runtimeContextToUse,
          mastra: this.#mastra,
          resourceId: inputData.resourceId,
          threadId: runId,
          runId,
          context: inputDataToUse,
        });

        const memory = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
        const initData = await getInitData();
        await memory?.saveMessages({
          messages: [
            {
              id: randomUUID() as string,
              type: 'text',
              role: 'assistant',
              content: { parts: [{ type: 'text', text: JSON.stringify(finalResult) }], format: 2 },
              createdAt: new Date(),
              threadId: initData.threadId || runId,
              resourceId: initData.threadResourceId || this.name,
            },
          ] as MastraMessageV2[],
          format: 'v2',
        });

        return {
          task: inputData.task,
          resourceId: inputData.resourceId,
          resourceType: inputData.resourceType,
          result: finalResult,
          isComplete: false,
          iteration: inputData.iteration,
        };
      },
    });

    const finishStep = createStep({
      id: 'finish-step',
      inputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        selectionReason: z.string(),
        iteration: z.number(),
      }),
      outputSchema: z.object({
        task: z.string(),
        result: z.string(),
        isComplete: z.boolean(),
        iteration: z.number(),
      }),
      execute: async ({ inputData }) => {
        return {
          task: inputData.task,
          result: inputData.result,
          isComplete: !!inputData.isComplete,
          iteration: inputData.iteration,
        };
      },
    });

    const networkWorkflow = createWorkflow({
      id: 'Agent-Network-Outer-Workflow',
      inputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        result: z.string().optional(),
        iteration: z.number(),
        threadId: z.string().optional(),
        threadResourceId: z.string().optional(),
        isOneOff: z.boolean(),
      }),
      outputSchema: z.object({
        task: z.string(),
        resourceId: z.string(),
        resourceType: RESOURCE_TYPES,
        prompt: z.string(),
        result: z.string(),
        isComplete: z.boolean().optional(),
        completionReason: z.string().optional(),
        iteration: z.number(),
        threadId: z.string().optional(),
        threadResourceId: z.string().optional(),
        isOneOff: z.boolean(),
      }),
    });

    networkWorkflow
      .then(routingStep)
      .branch([
        [async ({ inputData }) => !inputData.isComplete && inputData.resourceType === 'agent', agentStep],
        [async ({ inputData }) => !inputData.isComplete && inputData.resourceType === 'workflow', workflowStep],
        [async ({ inputData }) => !inputData.isComplete && inputData.resourceType === 'tool', toolStep],
        [async ({ inputData }) => inputData.isComplete, finishStep],
      ])
      .map({
        task: {
          step: [routingStep, agentStep, workflowStep, toolStep],
          path: 'task',
        },
        isComplete: {
          step: [agentStep, workflowStep, toolStep, finishStep],
          path: 'isComplete',
        },
        completionReason: {
          step: [routingStep, agentStep, workflowStep, toolStep, finishStep],
          path: 'completionReason',
        },
        result: {
          step: [agentStep, workflowStep, toolStep, finishStep],
          path: 'result',
        },
        resourceId: {
          step: [routingStep, agentStep, workflowStep, toolStep],
          path: 'resourceId',
        },
        resourceType: {
          step: [routingStep, agentStep, workflowStep, toolStep],
          path: 'resourceType',
        },
        iteration: {
          step: [routingStep, agentStep, workflowStep, toolStep],
          path: 'iteration',
        },
        isOneOff: {
          initData: networkWorkflow,
          path: 'isOneOff',
        },
        threadId: {
          initData: networkWorkflow,
          path: 'threadId',
        },
        threadResourceId: {
          initData: networkWorkflow,
          path: 'threadResourceId',
        },
      })
      .commit();

    return networkWorkflow;
  }

  async generate(
    message: string,
    {
      runtimeContext,
      threadId,
      resourceId,
    }: { runtimeContext?: RuntimeContext; threadId?: string; resourceId?: string },
  ) {
    const networkWorkflow = this.createWorkflow({ runtimeContext });
    const run = networkWorkflow.createRun();

    const memory = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
    await memory?.saveMessages({
      messages: [
        {
          id: randomUUID() as string,
          type: 'text',
          role: 'user',
          content: { parts: [{ type: 'text', text: message }], format: 2 },
          createdAt: new Date(),
          threadId: threadId || run.runId,
          resourceId: resourceId || this.name,
        },
      ] as MastraMessageV2[],
      format: 'v2',
    });

    const result = await run.start({
      inputData: {
        task: message,
        resourceId: '',
        resourceType: 'none',
        iteration: 0,
        threadId,
        threadResourceId: resourceId,
        isOneOff: true,
      },
    });

    if (result.status === 'failed') {
      throw result.error;
    }

    if (result.status === 'suspended') {
      throw new Error('Workflow suspended');
    }

    return {
      task: result.result.task,
      result: result.result.result,
      resourceId: result.result.resourceId,
      resourceType: result.result.resourceType,
    };
  }

  async stream(
    message: string,
    {
      runtimeContext,
      threadId,
      resourceId,
    }: { runtimeContext?: RuntimeContext; resourceId?: string; threadId?: string },
  ) {
    const networkWorkflow = this.createWorkflow({ runtimeContext });
    const run = networkWorkflow.createRun();

    const memory = await this.getMemory({ runtimeContext: runtimeContext || new RuntimeContext() });
    await memory?.saveMessages({
      messages: [
        {
          id: randomUUID() as string,
          type: 'text',
          role: 'user',
          content: { parts: [{ type: 'text', text: message }], format: 2 },
          createdAt: new Date(),
          threadId: threadId || run.runId,
          resourceId: resourceId || this.name,
        },
      ] as MastraMessageV2[],
      format: 'v2',
    });

    return run.stream({
      inputData: {
        task: `You are executing just one primitive based on the following: ${message}`,
        resourceId: '',
        resourceType: 'none',
        iteration: 0,
        threadResourceId: resourceId,
        threadId,
        isOneOff: true,
      },
    });
  }
}
