/**
 * File Content Extractor — converts binary files to text or Claude content blocks.
 *
 * Dispatches by MIME type to the right extraction strategy:
 *   - PDF, images → Claude-native content blocks (no parsing needed)
 *   - docx → mammoth (text extraction)
 *   - xlsx → ExcelJS (sheets → CSV text)
 *   - pptx → JSZip + XML text node extraction
 *   - csv/tsv/txt/md/json → Buffer.toString()
 *   - html → htmlparser2 SAX tag stripping
 *
 * Security: max file size enforced before parsing. All parsers receive
 * bounded input. Unknown types return null (safe fallback).
 */

import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { Parser as HtmlParser } from 'htmlparser2';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';

// JSZip is a transitive dep of exceljs — import dynamically to avoid
// adding it as a direct dependency.
let _jszip: typeof import('jszip') | null = null;
async function getJSZip() {
  if (!_jszip) {
    const mod = await import('jszip');
    _jszip = mod.default ?? mod;
  }
  return _jszip;
}

// ── Constants ──
// File size and extraction limits loaded from config (drive.*)

/** Max file size we'll attempt to parse — loaded from config */
export function getMaxFileSizeBytes(): number { return getConfig().drive.maxFileSizeBytes; }

/** Max text output from extraction — loaded from config */
export function getMaxExtractedChars(): number { return getConfig().drive.maxExtractedChars; }

/** Max PDF size for Claude document blocks (32 MB API limit, leave headroom for base64 overhead) */
const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

/** Max image size for Claude image blocks (API limit 5 MB) */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

// ── Types ──

/** Plain text extracted from a file */
export interface TextContent {
  kind: 'text';
  text: string;
}

/** A Claude-native document block (PDF) */
export interface DocumentContent {
  kind: 'document';
  mediaType: 'application/pdf';
  base64: string;
}

/** A Claude-native image block */
export interface ImageContent {
  kind: 'image';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64: string;
}

export type ExtractedContent = TextContent | DocumentContent | ImageContent;

// ── MIME type classification ──

const PLAIN_TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/tsv',
  'application/json',
  'application/xml',
  'text/xml',
]);

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// ── Main dispatch ──

/**
 * Extract readable content from a file buffer.
 * Returns null if the file type is unsupported or extraction fails.
 */
export async function extractContent(
  buffer: Buffer,
  mimeType: string,
): Promise<ExtractedContent | null> {
  if (buffer.length > getMaxFileSizeBytes()) {
    logger.warn({ mimeType, size: buffer.length, max: getMaxFileSizeBytes() }, 'File exceeds max size — skipping extraction');
    return null;
  }

  if (buffer.length === 0) {
    return null;
  }

  try {
    // PDF → Claude-native document block
    if (mimeType === 'application/pdf') {
      return extractPdf(buffer);
    }

    // Images → Claude-native image block
    if (IMAGE_MIMES.has(mimeType)) {
      return extractImage(buffer, mimeType as ImageContent['mediaType']);
    }

    // Plain text formats → direct toString
    if (PLAIN_TEXT_MIMES.has(mimeType) || mimeType.startsWith('text/plain')) {
      return extractPlainText(buffer);
    }

    // HTML
    if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
      return extractHtml(buffer);
    }

    // Word (.docx)
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return await extractDocx(buffer);
    }

    // Excel (.xlsx)
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      return await extractXlsx(buffer);
    }

    // PowerPoint (.pptx)
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      return await extractPptx(buffer);
    }

    // Legacy Office formats — best-effort via extension sniffing in the mime
    if (mimeType === 'application/msword') {
      // .doc (legacy) — can't parse without native binaries, fall through
      logger.debug({ mimeType }, 'Legacy .doc format — no parser available');
      return null;
    }

    logger.debug({ mimeType }, 'Unsupported mime type for extraction');
    return null;
  } catch (error) {
    logger.warn({ error, mimeType }, 'File content extraction failed');
    return null;
  }
}

// ── Format-specific extractors ──

function extractPdf(buffer: Buffer): ExtractedContent | null {
  if (buffer.length > MAX_PDF_SIZE_BYTES) {
    logger.warn({ size: buffer.length }, 'PDF exceeds Claude API size limit — skipping');
    return null;
  }
  return {
    kind: 'document',
    mediaType: 'application/pdf',
    base64: buffer.toString('base64'),
  };
}

function extractImage(buffer: Buffer, mediaType: ImageContent['mediaType']): ExtractedContent | null {
  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    logger.warn({ size: buffer.length }, 'Image exceeds Claude API size limit — skipping');
    return null;
  }
  return {
    kind: 'image',
    mediaType,
    base64: buffer.toString('base64'),
  };
}

function extractPlainText(buffer: Buffer): TextContent {
  const text = buffer.toString('utf-8').slice(0, getMaxExtractedChars());
  return { kind: 'text', text };
}

function extractHtml(buffer: Buffer): TextContent {
  const html = buffer.toString('utf-8');
  const chunks: string[] = [];
  let totalChars = 0;
  let skipContent = false;

  const parser = new HtmlParser({
    onopentag(name) {
      // Skip script, style, and SVG content
      if (name === 'script' || name === 'style' || name === 'svg') {
        skipContent = true;
      }
      // Block elements get a newline separator
      if (BLOCK_ELEMENTS.has(name) && chunks.length > 0) {
        chunks.push('\n');
      }
    },
    ontext(text) {
      if (skipContent || totalChars >= getMaxExtractedChars()) return;
      const trimmed = text.replace(/\s+/g, ' ');
      if (trimmed.trim()) {
        const remaining = getMaxExtractedChars() - totalChars;
        const sliced = trimmed.slice(0, remaining);
        chunks.push(sliced);
        totalChars += sliced.length;
      }
    },
    onclosetag(name) {
      if (name === 'script' || name === 'style' || name === 'svg') {
        skipContent = false;
      }
    },
  });

  parser.write(html);
  parser.end();

  // Collapse multiple newlines and trim
  const text = chunks.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { kind: 'text', text };
}

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'td', 'th', 'tr', 'ul',
]);

async function extractDocx(buffer: Buffer): Promise<TextContent> {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.slice(0, getMaxExtractedChars());
  return { kind: 'text', text };
}

async function extractXlsx(buffer: Buffer): Promise<TextContent> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types expect legacy Buffer — cast to satisfy Node 22 Uint8Array-based Buffer
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const lines: string[] = [];
  let totalChars = 0;

  for (const sheet of workbook.worksheets) {
    if (totalChars >= getMaxExtractedChars()) break;

    lines.push(`--- Sheet: ${sheet.name} ---`);
    totalChars += sheet.name.length + 16;

    sheet.eachRow((row) => {
      if (totalChars >= getMaxExtractedChars()) return;
      const values = row.values as (string | number | boolean | null | undefined)[];
      // row.values is 1-indexed — first element is undefined
      const cells = values.slice(1).map(v => {
        if (v == null) return '';
        if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result);
        return String(v);
      });
      const line = cells.join(',');
      lines.push(line);
      totalChars += line.length + 1;
    });
  }

  const text = lines.join('\n').slice(0, getMaxExtractedChars());
  return { kind: 'text', text };
}

async function extractPptx(buffer: Buffer): Promise<TextContent> {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? '0');
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? '0');
      return numA - numB;
    });

  const textParts: string[] = [];
  let totalChars = 0;

  for (const slidePath of slideFiles) {
    if (totalChars >= getMaxExtractedChars()) break;

    const xml = await zip.files[slidePath].async('text');
    // Extract text from <a:t> tags (PowerPoint text runs)
    const texts: string[] = [];
    for (const match of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) {
      if (match[1]) texts.push(match[1]);
    }

    if (texts.length > 0) {
      const slideNum = slidePath.match(/slide(\d+)/)?.[1] ?? '?';
      const slideText = `--- Slide ${slideNum} ---\n${texts.join(' ')}`;
      textParts.push(slideText);
      totalChars += slideText.length + 1;
    }
  }

  const text = textParts.join('\n\n').slice(0, getMaxExtractedChars());
  return { kind: 'text', text };
}
