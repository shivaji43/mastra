import { isVercelTool } from '@mastra/core/tools';
import { zodToJsonSchema } from './zod-to-json-schema';
import type { ToolsInput } from '@mastra/core/agent';

export function processClientTools(clientTools: ToolsInput | undefined): ToolsInput | undefined {
  if (!clientTools) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(clientTools).map(([key, value]) => {
      if (isVercelTool(value)) {
        return [
          key,
          {
            ...value,
            parameters: value.parameters ? zodToJsonSchema(value.parameters) : undefined,
          },
        ];
      } else {
        return [
          key,
          {
            ...value,
            inputSchema: value.inputSchema ? zodToJsonSchema(value.inputSchema) : undefined,
            outputSchema: value.outputSchema ? zodToJsonSchema(value.outputSchema) : undefined,
          },
        ];
      }
    }),
  );
}
