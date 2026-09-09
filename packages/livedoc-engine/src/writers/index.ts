import type { Writer } from './types.js';
import { markdownWriter } from './markdown.js';
import { htmlWriter } from './html.js';
import { yamlWriter, InvalidYamlOutputError } from './yaml.js';
import { jsonWriter, InvalidJsonOutputError } from './json.js';
import { textWriter } from './text.js';
import { hwpxWriter, KordocNotInstalledError } from './hwpx.js';

const REGISTRY: Record<string, Writer> = {
  markdown: markdownWriter,
  html: htmlWriter,
  yaml: yamlWriter,
  json: jsonWriter,
  text: textWriter,
  hwpx: hwpxWriter,
};

export function getWriter(format: string): Writer {
  const w = REGISTRY[format];
  if (!w) throw new Error(`No writer registered for output format '${format}'`);
  return w;
}

export type { Writer, WriterContext, WriterResult } from './types.js';
export { markdownWriter, htmlWriter, yamlWriter, jsonWriter, textWriter };
export { InvalidYamlOutputError, InvalidJsonOutputError, KordocNotInstalledError };
