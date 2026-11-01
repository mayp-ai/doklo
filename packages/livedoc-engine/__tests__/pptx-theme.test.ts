import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPptxBuffer, type PptxView } from '../src/pptx/generate.js';
import { ENGINE_DEFAULT_THEME, type ResolvedTheme } from '../src/theme.js';

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63680000000200015a4d57f50000000049454e44ae426082',
  'hex',
);

const STRINGS: PptxView['strings'] = {
  generatedBy: 'by', step: '단계', actorSystem: '시스템', screenshotDrop: 'drop',
  docInfo: '문서 정보', docName: '문서명', docSystem: '대상 시스템', docVersion: '버전', docAsOf: '기준일', docReaders: '대상 독자',
  revisionHistory: '개정 이력', colVersion: '버전', colDate: '일자', colChange: '내용', colAuthor: '작성', firstEdition: '최초 작성',
  toc: '목차', ch1: '1. 개요', ch2: '2. 접속', ch3: '3. 메뉴', ch4: '4. 화면', ch5: '5. 유의사항', ch6: '6. 문의처', appendix: '부록',
  purposeTitle: '1.1 목적', purposeText: '{project} 사용 방법', readersTitle: '1.2 대상', legendTitle: '1.3 표기',
  legendNumber: '번호', legendPath: '경로', legendButton: '버튼', legendNote: '유의', accessTitle: '2.1 접속', appUrlLabel: '주소',
  colRole: '역할', colRoleDesc: '설명', colRoleFeatures: '기능 수', colGroup: '분류', colFeature: '기능', colDesc: '설명',
  colSection: '절', colId: 'ID', colScreens: '화면 수', featureRoute: '경로', featureRoles: '역할', featurePreconditions: '전제',
  featureScreens: '화면 수', cautionsTitle: '유의사항', checksTitle: '확인', stepAction: '하는 일', stepResult: '결과',
  stepPrecondition: '전제', stepPlatforms: '플랫폼', screenOf: '화면', screenDescription: '화면 설명', captureNote: '캡처',
  colCaution: '유의사항', contactText: '문의', supportLabel: '문의처', ungrouped: '기능', andMore: '외 {n}개', none: '—', page: '쪽',
};

function baseView(theme: ResolvedTheme): PptxView {
  return {
    locale: 'ko',
    generatedAt: '2026-06-04T00:00:00.000Z',
    theme,
    document: { title: 'Title', project: 'Project', organization: '', version: '1.0', classification: '', asOf: '2026년 6월 4일' },
    roles: [{ name: 'Admin', description: 'runs it', featureCount: 1 }],
    groups: [{
      label: 'Group',
      features: [{
        dokId: 'X-001', title: 'Title', description: 'Desc', roles: ['Admin'],
        steps: [{ number: 1, actorLabel: 'Admin', isSystem: false, intent: 'Do', outcome: 'Done' }],
        cautions: [], checks: [],
      }],
    }],
    strings: STRINGS,
  };
}

describe('renderPptxBuffer with theme', () => {
  it('produces canonical-identical bytes for the same view', async () => {
    const first = await renderPptxBuffer(baseView(ENGINE_DEFAULT_THEME));
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const second = await renderPptxBuffer(baseView(ENGINE_DEFAULT_THEME));

    expect(second.equals(first)).toBe(true);
  }, 10_000);

  it('produces a non-empty buffer with the default theme', async () => {
    const buf = await renderPptxBuffer(baseView(ENGINE_DEFAULT_THEME));
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304'); // valid ZIP (pptx) magic
  });

  it('produces a non-empty buffer with a custom-color theme', async () => {
    const theme: ResolvedTheme = { ...ENGINE_DEFAULT_THEME, colors: { ...ENGINE_DEFAULT_THEME.colors, accent: '0B3D91' } };
    const buf = await renderPptxBuffer(baseView(theme));
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304'); // valid ZIP (pptx) magic
  });
});

describe('renderPptxBuffer with branding extras', () => {
  it('renders with a logo, footer, page numbers and cover color', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'logo-'));
    try {
      const logo = join(dir, 'logo.png');
      await writeFile(logo, PNG_1x1);
      const theme: ResolvedTheme = {
        ...ENGINE_DEFAULT_THEME,
        logo: { assetPath: logo, position: 'top-right', maxHeight: 0.4 },
        footer: { text: 'Confidential', showPageNumber: true },
        cover: { backgroundColor: '0B3D91' },
      };
      const buf = await renderPptxBuffer(baseView(theme));
      expect(buf.byteLength).toBeGreaterThan(0);
      expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
      const xml = buf.toString('latin1');
      expect(xml).toContain('ppt/media/');      // logo image embedded
      expect(xml).toContain('Confidential');    // footer text in slide XML
      expect(xml).toContain('0B3D91');           // cover band color in slide XML
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('step screenshot placement + annotation overlay', () => {
  /** PNG with a forged IHDR claiming 1280x800 — pngSize reads only the header. */
  function fakePng(w: number, h: number): Buffer {
    const buf = Buffer.from(PNG_1x1);
    buf.writeUInt32BE(w, 16);
    buf.writeUInt32BE(h, 20);
    return buf;
  }

  it('letterboxes the image itself and draws a transparent annotation box on the same fit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pptx-ann-'));
    try {
      const shot = join(dir, 'step-1.png');
      await writeFile(shot, fakePng(1280, 800));
      const view = baseView(ENGINE_DEFAULT_THEME);
      view.groups[0]!.features[0]!.steps = [{
        number: 1, actorLabel: 'User', isSystem: false, intent: 'Click', outcome: 'Clicked',
        screenshotPath: shot,
        annotation: { x: 26.64, y: 64.56, w: 46.72, h: 5.5 },
      }];
      const buf = await renderPptxBuffer(view);

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buf);
      // The screen slide is the first slide that carries a picture.
      const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(
        (a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]),
      );
      let slide = '';
      for (const name of slideNames) {
        const xml = await zip.file(name)!.async('string');
        if (xml.includes('<p:pic>')) { slide = xml; break; }
      }
      const EMU = 914400;

      // Image: contain fit of a 1.6-AR image in the 6.0x4.3 region →
      // 6.0x3.75 centered vertically at y = 1.0 + (4.3-3.75)/2 = 1.275.
      const pic = /<p:pic>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/.exec(slide);
      expect(pic).toBeTruthy();
      const [, , py, , pcy] = pic!.map(Number);
      expect(py! / EMU).toBeCloseTo(1.275, 2);
      expect(pcy! / EMU).toBeCloseTo(3.75, 2);

      // Annotation rect: y = 1.275 + 0.6456*3.75 ≈ 3.696, with a
      // fully-transparent solid fill (alpha 0), never a missing fill.
      const annY = Math.round((1.275 + 0.6456 * 3.75) * EMU);
      const rects = [...slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
      const annot = rects.find((r) => {
        const off = /<a:off x="-?\d+" y="(\d+)"/.exec(r);
        return off && Math.abs(Number(off[1]) - annY) < EMU * 0.01;
      });
      expect(annot).toBeTruthy();
      expect(annot!).toContain('<a:alpha val="0"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
