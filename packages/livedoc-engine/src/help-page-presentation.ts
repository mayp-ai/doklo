import Handlebars from 'handlebars';

type Variables = Record<string, string | boolean | number>;

/** Validate before template compilation, including saved Publication creation. */
export function validateHelpPagePresentation(variables: Variables): void {
  const level = variables['heading_level'] ?? 1;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 5) {
    throw new Error("Variable 'heading_level' must be an integer from 1 to 5 (sections use the next level)");
  }
  const prefix = variables['id_prefix'];
  if (prefix !== undefined && (typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(prefix))) {
    throw new Error("Variable 'id_prefix' must start with a letter and contain only letters, digits, underscores, or hyphens (1–64 characters)");
  }
}

export function helpPagePresentation(dokId: string, locale: string, variables: Variables) {
  validateHelpPagePresentation(variables);
  const level = variables['heading_level'] ?? 1;
  const prefix = variables['id_prefix'];
  // Encode the complete values, without lossy slugification or truncation.
  // Hex cannot contain delimiters or suffixes, even if the ID grammar expands.
  const articleId = `doklo-help--p${Buffer.from(String(prefix ?? ''), 'utf8').toString('hex')}--d${Buffer.from(dokId, 'utf8').toString('hex')}`;
  return {
    article_id: articleId,
    title_id: `${articleId}--title`,
    title_tag: `h${level}`,
    section_tag: `h${Number(level) + 1}`,
    // HTML template compilation intentionally disables automatic escaping.
    lang: Handlebars.escapeExpression(locale),
    how_id: `${articleId}--how`,
    how_title_id: `${articleId}--how-title`,
    tips_id: `${articleId}--tips`,
    tips_title_id: `${articleId}--tips-title`,
    done_id: `${articleId}--done`,
    done_title_id: `${articleId}--done-title`,
  };
}
