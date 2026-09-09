import { z } from 'zod';
import { DokIdSchema } from '@doklo-beta/core';

/**
 * Workspace-level capture config lives at `<workspaceRoot>/.doklo/capture.yaml`
 * (or `.json`). Each Dok lists the per-step recipe used by the orchestrator.
 *
 * The choice to put this OUTSIDE the v5 Dok schema is deliberate. A Dok's
 * business definition (intent / outcome / business_rules / acceptance_criteria)
 * should NOT carry presentation-layer details like a DOM selector. capture.yaml
 * is the workspace's *render-time* annotation layer that pairs Dok IDs with
 * the navigation + interaction recipe needed to materialize each step on screen.
 *
 * When the v2 LLM-driven capture-hint generator lands, it will write to this
 * same file format — the recipe lives in one place, not duplicated across
 * Hub + render config.
 */

export const CaptureAuthLoginFormSchema = z.object({
  type: z.literal('login_form'),
  url: z.string().min(1),
  email_selector: z.string().min(1),
  password_selector: z.string().min(1),
  submit_selector: z.string().min(1),
  /** Selector that appears post-login to signal success. */
  success_selector: z.string().optional(),
  /** Either inline credentials (NOT recommended for committed config) or env. */
  email_env: z.string().optional(),
  password_env: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
});

export const CaptureAuthCookieSchema = z.object({
  type: z.literal('cookie'),
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string().optional(),
    value_env: z.string().optional(),
    domain: z.string(),
    path: z.string().default('/'),
  })),
});

export const CaptureAuthNoneSchema = z.object({ type: z.literal('none') });

export const CaptureAuthSchema = z.discriminatedUnion('type', [
  CaptureAuthLoginFormSchema,
  CaptureAuthCookieSchema,
  CaptureAuthNoneSchema,
]);

export const CaptureActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string().min(1) }),
  z.object({ type: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('select'), selector: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }),
  z.object({ type: z.literal('hover'), selector: z.string().min(1) }),
  z.object({ type: z.literal('wait'), ms: z.number().int().nonnegative() }),
  z.object({ type: z.literal('wait_for'), selector: z.string().min(1) }),
  z.object({
    type: z.literal('eval'),
    /** JS expression run in page context, e.g. `document.querySelector('.x').focus()`. */
    expr: z.string().min(1),
  }),
]);

export const CaptureStepRecipeSchema = z.object({
  step: z.number().int().positive(),
  /** Relative or absolute URL to navigate to before running actions. Optional — falls through to base_url + path of previous step. */
  url: z.string().optional(),
  /** Wait for this selector before screenshotting. */
  wait_for: z.string().optional(),
  /** Wait this long after actions before screenshotting (ms). */
  settle_ms: z.number().int().nonnegative().optional(),
  /** Action sequence run after navigation, before screenshot. */
  actions: z.array(CaptureActionSchema).default([]),
  /**
   * Element the user interacts with on THIS screen. The orchestrator measures
   * its on-screen bounding box (% of the screenshot) and records it in
   * annotations.json — downstream renderers (pptx/html) draw a crisp numbered
   * box exactly on it. This replaces the old bake-an-outline-into-the-PNG
   * `highlight` (which produced fuzzy / misplaced boxes). If absent, `highlight`
   * is used as a fallback target.
   */
  annotate: z.string().optional(),
  /** Legacy: outline baked into the PNG. Now also used as an annotate fallback. */
  highlight: z.string().optional(),
  /** Force a specific viewport for this step. Inherits Dok's default otherwise. */
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  /** Crop to this element (instead of full page). */
  clip_selector: z.string().optional(),
  /** Skip annotation, just capture as-is. */
  raw: z.boolean().optional(),
});

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** Filesystem segment used below a Dok's screenshot directory. */
export const CapturePlatformLabelSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'platform label must be a safe lowercase segment');

export const CaptureDokRecipeSchema = z.object({
  viewport: ViewportSchema.default({ width: 1280, height: 800 }),
  /**
   * Optional platform → viewport map. When set, the orchestrator captures the
   * recipe once per platform, writing to `.doklo/screenshots/<DOK>/<platform>/`.
   * Keys should be one of: desktop, mobile, tablet, tv, cli, voice (the engine's
   * known platform set). Example:
   *   platforms: { desktop: {width:1280,height:800}, mobile: {width:390,height:844} }
   * When absent, a single flat capture runs into `.doklo/screenshots/<DOK>/`.
   */
  platforms: z.record(CapturePlatformLabelSchema, ViewportSchema).optional(),
  steps: z.array(CaptureStepRecipeSchema).min(1).superRefine((steps, ctx) => {
    const seen = new Set<number>();
    for (const [index, step] of steps.entries()) {
      if (seen.has(step.step)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate step number ${step.step}`,
          path: [index, 'step'],
        });
      }
      seen.add(step.step);
    }
  }),
});

export const CaptureConfigSchema = z.object({
  base_url: z.string().min(1),
  auth: CaptureAuthSchema.default({ type: 'none' }),
  /** Map of Dok ID → step recipes. */
  doks: z.record(DokIdSchema, CaptureDokRecipeSchema).default({}),
});

export type CaptureAuth = z.infer<typeof CaptureAuthSchema>;
export type CaptureAction = z.infer<typeof CaptureActionSchema>;
export type CaptureStepRecipe = z.infer<typeof CaptureStepRecipeSchema>;
export type CaptureDokRecipe = z.infer<typeof CaptureDokRecipeSchema>;
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

export function parseCaptureConfig(raw: unknown): CaptureConfig {
  return CaptureConfigSchema.parse(raw);
}
