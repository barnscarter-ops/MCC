// Document text extraction for the /api/extract-file endpoint. Pulls electrical findings
// out of home-inspection PDFs (with an Anthropic vision fallback for scanned/image PDFs)
// and raw text out of .docx. Pure leaf: reads the request, writes the JSON response.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonBody, sendJson } from './http.mjs';
import { resolveSafePath } from './exec.mjs';
import { anthropicApiKey, anthropicModel } from './config.mjs';

export async function handleExtractFile(req, res) {
  try {
    const body = await readJsonBody(req, 50_000_000); // 50MB — PDFs can be large as base64
    const { name = '', data, path: filePath } = body;
    const ext = path.extname(name || filePath || '').toLowerCase();
    let text = '';
    const { createRequire } = await import('module');
    const requireFn = createRequire(import.meta.url);

    async function extractPdf(buf) {
      const pdfParse = requireFn('pdf-parse');
      const result = await pdfParse(buf).catch(() => ({ text: '' }));
      const raw = result.text || '';

      // Scanned/image-based PDF — pdf-parse returns nothing; fall back to Anthropic vision
      if (raw.length < 500) {
        if (!anthropicApiKey) return '[PDF is image-based and ANTHROPIC_API_KEY is not set]';
        const b64 = buf.toString('base64');
        const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
          body: JSON.stringify({
            model: anthropicModel,
            max_tokens: 4096,
            messages: [{
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                { type: 'text', text: 'This is a home inspection report. Extract ALL electrical findings: deficiencies, items requiring a licensed electrician, safety hazards (GFCI, AFCI, smoke detectors, bonding, grounding), and any item marked deficient or in need of repair. Quote the report text exactly, including section headings and item numbers.' }
              ]
            }]
          }),
        });
        if (!visionRes.ok) return `[Vision extraction failed: ${visionRes.status}]`;
        const visionData = await visionRes.json();
        return (visionData.content?.[0]?.text || '[no content returned]').slice(0, 32000);
      }

      // Primary: find the ELECTRICAL SYSTEMS section header directly (works for TREC and most inspection reports)
      const elecMatch = /\bELECTRICAL\s+SYSTEMS?\b/i.exec(raw);
      if (elecMatch) {
        const start = elecMatch.index;
        // Find the next major section after electrical
        const nextSection = /\n(?:[IVX]{2,}\.[ \t]|(?:HEATING|HVAC|PLUMBING|APPLIANCE|OPTIONAL|ADDITIONAL INFO))/i.exec(raw.slice(start + 200));
        const end = nextSection ? start + 200 + nextSection.index : raw.length;
        return raw.slice(start, end).slice(0, 32000);
      }

      // Fallback: keyword density scoring on form-feed pages or sliding window
      const ELEC = ['electrical','gfci','afci','arc-fault','arc fault','panel','breaker','circuit','wiring','outlet','receptacle','switch','bonding','grounding','licensed electrician','deficien','smoke alarm','smoke detector'];
      const score = t => { const l = t.toLowerCase(); return ELEC.reduce((n, kw) => n + (l.includes(kw) ? 1 : 0), 0); };
      let pages = raw.split('\f').filter(p => p.trim());
      if (pages.length <= 1) {
        const STEP = 1800;
        pages = [];
        for (let i = 0; i < raw.length; i += STEP) pages.push(raw.slice(i, i + 2000));
      }
      const scored = pages.map((t, i) => ({ i, t, s: score(t) }));
      const skip = Math.floor(pages.length * 0.1);
      const hot = scored.filter(p => p.i >= skip && p.s >= 2);
      if (hot.length === 0) return raw.slice(0, 32000);
      const keep = new Set();
      hot.forEach(p => { keep.add(p.i - 1); keep.add(p.i); keep.add(p.i + 1); });
      return [...keep].sort((a, b) => a - b)
        .filter(i => i >= 0 && i < pages.length)
        .map(i => pages[i].trim())
        .join('\n\n')
        .slice(0, 32000);
    }

    if (filePath) {
      const abs = resolveSafePath(filePath);
      if (!abs) { sendJson(res, 400, { error: 'path not allowed' }); return; }
      const buf = fs.readFileSync(abs);
      if (ext === '.pdf') {
        text = await extractPdf(buf);
      } else if (ext === '.docx') {
        const { default: mammoth } = await import('mammoth');
        text = ((await mammoth.extractRawText({ buffer: buf })).value) || '';
      } else {
        text = buf.toString('utf8');
      }
    } else if (data) {
      const buf = Buffer.from(data, 'base64');
      if (ext === '.pdf') {
        text = await extractPdf(buf);
      } else if (ext === '.docx') {
        const { default: mammoth } = await import('mammoth');
        text = ((await mammoth.extractRawText({ buffer: buf })).value) || '';
      } else {
        text = buf.toString('utf8');
      }
    }
    sendJson(res, 200, { text: text.slice(0, 32000) });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}
