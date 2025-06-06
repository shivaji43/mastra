import type { LanguageModel } from '@mastra/core/llm';
import { z } from 'zod';

import { MastraAgentJudge } from '../../judge';
import { generateClaimExtractionPrompt } from '../faithfulness/prompts';
import { generateEvaluatePrompt, HALLUCINATION_AGENT_INSTRUCTIONS, generateReasonPrompt } from './prompts';

export class HallucinationJudge extends MastraAgentJudge {
  constructor(model: LanguageModel) {
    super('Hallucination', HALLUCINATION_AGENT_INSTRUCTIONS, model);
  }

  async evaluate(output: string, context: string[]): Promise<{ statement: string; verdict: string; reason: string }[]> {
    const claimsPrompt = generateClaimExtractionPrompt({ output });
    const claims = await this.agent.generate(claimsPrompt, {
      output: z.object({
        claims: z.array(z.string()),
      }),
    });

    if (claims.object.claims.length === 0) {
      return [];
    }

    const evaluatePrompt = generateEvaluatePrompt({ claims: claims.object.claims, context });
    const result = await this.agent.generate(evaluatePrompt, {
      output: z.object({
        verdicts: z.array(
          z.object({
            statement: z.string(),
            verdict: z.string(),
            reason: z.string(),
          }),
        ),
      }),
    });

    return result.object.verdicts;
  }

  async getReason(args: {
    input: string;
    output: string;
    context: string[];
    score: number;
    scale: number;
    verdicts: { verdict: string; reason: string }[];
  }): Promise<string> {
    const prompt = generateReasonPrompt(args);
    const result = await this.agent.generate(prompt, {
      output: z.object({ reason: z.string() }),
    });
    return result.object.reason;
  }
}
