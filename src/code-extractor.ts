export interface ExtractedCode {
  type: 'numeric' | 'alphanumeric' | 'link';
  value: string;
  confidence: number;
  context: string;
}

const CODE_KEYWORDS =
  /验证码|verification|verify|code|otp|pin|passcode|one.?time|确认码|安全码|动态码|captcha/i;

const LINK_KEYWORDS =
  /verify|confirm|activate|token|click|validate|magic|login|auth|reset|unsubscribe/i;

const YEAR_RE = /^(202[0-9]|203[0-9])$/;
const PHONE_CONTEXT = /phone|电话|手机|tel|fax/i;
const MONEY_CONTEXT = /\$|¥|€|£|价格|金额|amount|price|total|fee/i;

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractContext(text: string, pos: number, radius = 40): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return text.slice(start, end).trim();
}

function extractNumericCodes(text: string): ExtractedCode[] {
  const results: ExtractedCode[] = [];
  const re = /\b(\d{4,8})\b/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const value = match[1];
    const ctx = extractContext(text, match.index);

    if (YEAR_RE.test(value)) continue;
    if (PHONE_CONTEXT.test(ctx)) continue;
    if (MONEY_CONTEXT.test(ctx)) continue;
    if (/^\d{5}$/.test(value) && /zip|postal|邮编/i.test(ctx)) continue;

    let confidence = 0.3;
    if (CODE_KEYWORDS.test(ctx)) confidence = 0.9;
    if (value.length === 6) confidence += 0.05;
    if (/[:：]\s*\d/.test(ctx)) confidence += 0.05;

    results.push({ type: 'numeric', value, confidence: Math.min(confidence, 1), context: ctx });
  }

  return results;
}

function extractAlphanumericCodes(text: string): ExtractedCode[] {
  const results: ExtractedCode[] = [];
  const re = /\b([A-Za-z0-9]{4,10})\b/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const value = match[1];
    if (/^\d+$/.test(value) || /^[A-Za-z]+$/.test(value)) continue;

    const ctx = extractContext(text, match.index);
    if (!CODE_KEYWORDS.test(ctx)) continue;

    results.push({
      type: 'alphanumeric',
      value,
      confidence: 0.7,
      context: ctx,
    });
  }

  return results;
}

function extractLinks(html: string): ExtractedCode[] {
  const results: ExtractedCode[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    const url = match[1];
    if (!url.startsWith('http')) continue;
    if (!LINK_KEYWORDS.test(url)) continue;
    if (/unsubscribe/i.test(url)) continue;

    let confidence = 0.6;
    if (/verify|confirm|activate/i.test(url)) confidence = 0.85;
    if (/magic|login.*token|auth.*token/i.test(url)) confidence = 0.8;
    if (/token=|code=|key=/i.test(url)) confidence += 0.1;

    results.push({
      type: 'link',
      value: url,
      confidence: Math.min(confidence, 1),
      context: url.slice(0, 80),
    });
  }

  return results;
}

export function extractCodes(email: {
  subject: string;
  text?: string;
  html?: string;
}): ExtractedCode[] {
  const plainText = email.text || (email.html ? stripHtml(email.html) : '');
  const fullText = `${email.subject} ${plainText}`;

  const codes: ExtractedCode[] = [
    ...extractNumericCodes(fullText),
    ...extractAlphanumericCodes(fullText),
    ...(email.html ? extractLinks(email.html) : []),
  ];

  codes.sort((a, b) => b.confidence - a.confidence);

  const seen = new Set<string>();
  return codes.filter((c) => {
    if (seen.has(c.value)) return false;
    seen.add(c.value);
    return true;
  });
}
