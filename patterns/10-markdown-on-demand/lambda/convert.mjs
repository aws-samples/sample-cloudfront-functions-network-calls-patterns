// HTML to markdown with turndown (the converter the CloudFront + AWS WAF markdown sample uses).
// Only <main> (else <body>) is converted, so navigation and scripts stay out; the page
// title becomes YAML front matter that agents can read without parsing the text.
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript']);

export function toMarkdown(html) {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const main = /<main[^>]*>([\s\S]*)<\/main>/i.exec(html) || /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const markdown = turndown.turndown(main ? main[1] : html);
  const front = title && title[1].trim() ? '---\ntitle: ' + JSON.stringify(title[1].trim()) + '\n---\n\n' : '';
  return front + markdown + '\n';
}
