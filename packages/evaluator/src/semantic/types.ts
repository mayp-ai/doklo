// Tier 3 semantic judging — LLM is injected (JudgeFn), evaluator stays SDK-free.

export interface JudgeRequest {
  systemPrompt: string;
  userPrompt: string;
  label: string;
}

export interface JudgeResponse {
  success: boolean;
  content: string | null;
}

export type JudgeFn = (req: JudgeRequest) => Promise<JudgeResponse>;

export const SEMANTIC_AXES = [
  'business_clarity',
  'internal_consistency',
  'ac_verifiability',
  'coherence',
] as const;

export type SemanticAxis = (typeof SEMANTIC_AXES)[number];

export interface SemanticAxisScore {
  axis: SemanticAxis;
  score: number; // 0-25
  reason: string;
}

export interface DokSemanticResult {
  dokId: string;
  total: number; // 0-100
  axes: SemanticAxisScore[];
  flags: string[];
}

export interface SemanticReport {
  generatedAt: string;
  totalDoks: number;
  judged: number;
  average: number; // mean of judged totals, 0-100
  results: DokSemanticResult[];
  failures: Array<{ dokId: string; error: string }>;
}
