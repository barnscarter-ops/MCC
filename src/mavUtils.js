import React from 'react';

export function isDocumentResponse(text) {
  if (!text || text.length < 400) return false;
  const lines = text.split('\n');
  if (lines.length < 8) return false;
  const hasHeadings = text.includes('## ') || text.includes('# ');
  const hasBold = (text.match(/\*\*/g) || []).length >= 4;
  const docWords = [
    'Scope of Work', 'Terms and Conditions', 'Good / Better / Best',
    'Proposal', 'Estimate', 'Acceptance of Proposal',
    'Project Description', 'Pricing Summary',
  ];
  return hasHeadings || hasBold || docWords.some(w => text.includes(w));
}

function inlineFormat(text) {
  const parts = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2]) parts.push(React.createElement('strong', { key: m.index }, m[2]));
    else if (m[3]) parts.push(React.createElement('em', { key: m.index }, m[3]));
    else if (m[4]) parts.push(React.createElement('code', { key: m.index, className: 'mdCode' }, m[4]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

export function MavMarkdown({ content }) {
  const lines = content.split('\n');
  const elements = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        React.createElement('pre', { key: `pre-${i}`, className: 'mdPre' },
          React.createElement('code', { className: `mdPreCode${lang ? ` lang-${lang}` : ''}` },
            codeLines.join('\n')
          )
        )
      );
      i++; // skip closing ```
      continue;
    }

    if (line.startsWith('### ')) {
      elements.push(React.createElement('h3', { key: i, className: 'mdH3' }, line.slice(4)));
    } else if (line.startsWith('## ')) {
      elements.push(React.createElement('h2', { key: i, className: 'mdH2' }, line.slice(3)));
    } else if (line.startsWith('# ')) {
      elements.push(React.createElement('h1', { key: i, className: 'mdH1' }, line.slice(2)));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(React.createElement('li', { key: i }, inlineFormat(lines[i].slice(2))));
        i++;
      }
      elements.push(React.createElement('ul', { key: `ul-${i}`, className: 'mdUl' }, items));
      continue;
    } else if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(React.createElement('li', { key: i }, inlineFormat(lines[i].replace(/^\d+\.\s/, ''))));
        i++;
      }
      elements.push(React.createElement('ol', { key: `ol-${i}`, className: 'mdOl' }, items));
      continue;
    } else if (line.startsWith('|')) {
      // Markdown table — collect all consecutive | rows
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i]);
        i++;
      }
      // First row = header, second row = separator (skip it), rest = body
      const header = rows[0].split('|').filter((_, ci) => ci > 0 && ci < rows[0].split('|').length - 1);
      const body = rows.slice(2); // skip separator row
      elements.push(
        React.createElement('table', { key: `tbl-${i}`, className: 'mdTable' },
          React.createElement('thead', null,
            React.createElement('tr', null,
              header.map((cell, ci) => React.createElement('th', { key: ci, className: 'mdTh' }, inlineFormat(cell.trim())))
            )
          ),
          React.createElement('tbody', null,
            body.map((row, ri) => {
              const cells = row.split('|').filter((_, ci) => ci > 0 && ci < row.split('|').length - 1);
              return React.createElement('tr', { key: ri },
                cells.map((cell, ci) => React.createElement('td', { key: ci, className: 'mdTd' }, inlineFormat(cell.trim())))
              );
            })
          )
        )
      );
      continue;
    } else if (line.startsWith('---') || line.startsWith('___')) {
      elements.push(React.createElement('hr', { key: i, className: 'mdHr' }));
    } else if (line.trim() === '') {
      elements.push(React.createElement('div', { key: i, className: 'mdSpacer' }));
    } else {
      elements.push(React.createElement('p', { key: i, className: 'mdP' }, inlineFormat(line)));
    }
    i++;
  }
  return React.createElement('div', { className: 'mdDoc' }, elements);
}
