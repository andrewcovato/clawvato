import { describe, it, expect } from 'vitest';
import {
  extractContent,
  getMaxFileSizeBytes,
  getMaxExtractedChars,
} from '../../src/google/file-extractor.js';
import ExcelJS from 'exceljs';

// ── Helpers to create minimal valid Office files in-memory ──

async function createMinimalXlsx(data: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (const row of data) {
    sheet.addRow(row);
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function createMinimalPptx(slideTexts: string[]): Promise<Buffer> {
  // PPTX is a zip of XML files. Create a minimal valid one with jszip.
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // Minimal required files for a valid PPTX
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  ${slideTexts.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n')}
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);

  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
</p:presentation>`);

  for (let i = 0; i < slideTexts.length; i++) {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>${slideTexts[i]}</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}

// ── Tests ──

describe('file-extractor', () => {

  describe('extractContent — dispatch', () => {
    it('returns null for empty buffer', async () => {
      const result = await extractContent(Buffer.alloc(0), 'text/plain');
      expect(result).toBeNull();
    });

    it('returns null for oversized buffer', async () => {
      // Create a buffer just over the limit (don't actually allocate 50MB — mock the check)
      const buf = Buffer.alloc(getMaxFileSizeBytes() + 1);
      const result = await extractContent(buf, 'text/plain');
      expect(result).toBeNull();
    });

    it('returns null for unsupported mime type', async () => {
      const result = await extractContent(Buffer.from('data'), 'application/octet-stream');
      expect(result).toBeNull();
    });

    it('returns null for legacy .doc format', async () => {
      const result = await extractContent(Buffer.from('data'), 'application/msword');
      expect(result).toBeNull();
    });
  });

  describe('plain text extraction', () => {
    it('extracts text/plain', async () => {
      const result = await extractContent(Buffer.from('Hello world'), 'text/plain');
      expect(result).toEqual({ kind: 'text', text: 'Hello world' });
    });

    it('extracts text/csv as plain text', async () => {
      const csv = 'name,age\nAlice,30\nBob,25';
      const result = await extractContent(Buffer.from(csv), 'text/csv');
      expect(result).toEqual({ kind: 'text', text: csv });
    });

    it('extracts text/tab-separated-values', async () => {
      const tsv = 'name\tage\nAlice\t30';
      const result = await extractContent(Buffer.from(tsv), 'text/tab-separated-values');
      expect(result).toEqual({ kind: 'text', text: tsv });
    });

    it('extracts application/json', async () => {
      const json = '{"key": "value"}';
      const result = await extractContent(Buffer.from(json), 'application/json');
      expect(result).toEqual({ kind: 'text', text: json });
    });

    it('extracts text/markdown', async () => {
      const md = '# Hello\n\nWorld';
      const result = await extractContent(Buffer.from(md), 'text/markdown');
      expect(result).toEqual({ kind: 'text', text: md });
    });

    it('truncates text exceeding getMaxExtractedChars()', async () => {
      const longText = 'x'.repeat(getMaxExtractedChars() + 100);
      const result = await extractContent(Buffer.from(longText), 'text/plain');
      expect(result?.kind).toBe('text');
      expect((result as { text: string }).text.length).toBe(getMaxExtractedChars());
    });
  });

  describe('HTML extraction', () => {
    it('strips tags and extracts text', async () => {
      const html = '<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>';
      const result = await extractContent(Buffer.from(html), 'text/html');
      expect(result?.kind).toBe('text');
      const text = (result as { text: string }).text;
      expect(text).toContain('Title');
      expect(text).toContain('Hello world');
      expect(text).not.toContain('<');
    });

    it('strips script and style content', async () => {
      const html = '<html><head><style>body{color:red}</style></head><body><script>alert("xss")</script><p>Safe text</p></body></html>';
      const result = await extractContent(Buffer.from(html), 'text/html');
      const text = (result as { text: string }).text;
      expect(text).toContain('Safe text');
      expect(text).not.toContain('alert');
      expect(text).not.toContain('color:red');
    });

    it('preserves block-element line breaks', async () => {
      const html = '<div>First</div><div>Second</div>';
      const result = await extractContent(Buffer.from(html), 'text/html');
      const text = (result as { text: string }).text;
      expect(text).toContain('First\nSecond');
    });
  });

  describe('PDF extraction', () => {
    it('returns a document content block', async () => {
      const fakePdf = Buffer.from('%PDF-1.4 fake pdf content');
      const result = await extractContent(fakePdf, 'application/pdf');
      expect(result?.kind).toBe('document');
      expect((result as { mediaType: string }).mediaType).toBe('application/pdf');
      expect((result as { base64: string }).base64).toBe(fakePdf.toString('base64'));
    });

    it('rejects PDFs over size limit', async () => {
      // 21 MB — over the 20 MB PDF limit
      const largePdf = Buffer.alloc(21 * 1024 * 1024);
      const result = await extractContent(largePdf, 'application/pdf');
      expect(result).toBeNull();
    });
  });

  describe('image extraction', () => {
    it('returns an image content block for JPEG', async () => {
      const fakeJpeg = Buffer.from('fake jpeg data');
      const result = await extractContent(fakeJpeg, 'image/jpeg');
      expect(result?.kind).toBe('image');
      expect((result as { mediaType: string }).mediaType).toBe('image/jpeg');
    });

    it('returns an image content block for PNG', async () => {
      const fakePng = Buffer.from('fake png data');
      const result = await extractContent(fakePng, 'image/png');
      expect(result?.kind).toBe('image');
      expect((result as { mediaType: string }).mediaType).toBe('image/png');
    });

    it('supports GIF and WebP', async () => {
      for (const mime of ['image/gif', 'image/webp']) {
        const result = await extractContent(Buffer.from('data'), mime);
        expect(result?.kind).toBe('image');
      }
    });

    it('rejects images over 5 MB', async () => {
      const large = Buffer.alloc(6 * 1024 * 1024);
      const result = await extractContent(large, 'image/png');
      expect(result).toBeNull();
    });
  });

  describe('xlsx extraction', () => {
    it('extracts spreadsheet data as CSV text', async () => {
      const buf = await createMinimalXlsx([
        ['Name', 'Age'],
        ['Alice', '30'],
        ['Bob', '25'],
      ]);
      const result = await extractContent(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(result?.kind).toBe('text');
      const text = (result as { text: string }).text;
      expect(text).toContain('Sheet1');
      expect(text).toContain('Name');
      expect(text).toContain('Alice');
      expect(text).toContain('30');
    });

    it('handles multiple sheets', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Revenue').addRow(['Q1', '100']);
      workbook.addWorksheet('Expenses').addRow(['Q1', '50']);
      const arrayBuffer = await workbook.xlsx.writeBuffer();
      const buf = Buffer.from(arrayBuffer);

      const result = await extractContent(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const text = (result as { text: string }).text;
      expect(text).toContain('Revenue');
      expect(text).toContain('Expenses');
    });
  });

  describe('pptx extraction', () => {
    it('extracts slide text from pptx', async () => {
      const buf = await createMinimalPptx(['Introduction', 'Key Findings', 'Conclusion']);
      const result = await extractContent(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      expect(result?.kind).toBe('text');
      const text = (result as { text: string }).text;
      expect(text).toContain('Slide 1');
      expect(text).toContain('Introduction');
      expect(text).toContain('Key Findings');
      expect(text).toContain('Conclusion');
    });

    it('orders slides numerically', async () => {
      const buf = await createMinimalPptx(['First', 'Second']);
      const result = await extractContent(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      const text = (result as { text: string }).text;
      const firstIdx = text.indexOf('First');
      const secondIdx = text.indexOf('Second');
      expect(firstIdx).toBeLessThan(secondIdx);
    });
  });
});
