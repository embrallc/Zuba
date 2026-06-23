import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// MOCK report PDF. Proves the generation→upload→record pipeline end to end.
// The real renderer (lifted from the generate-report Edge Function, plus sharp
// image downscaling) replaces this in the follow-up. Returns raw PDF bytes
// (Uint8Array).
export async function buildMockPdf({ inspectionId, orgId, jobId } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { height } = page.getSize();

  let y = height - 72;
  const ink = rgb(0.11, 0.11, 0.18);
  const muted = rgb(0.42, 0.42, 0.46);
  const draw = (text, size = 12, f = font, color = ink) => {
    page.drawText(String(text), { x: 72, y, size, font: f, color });
    y -= size + 10;
  };

  draw("Zuba — Inspection Report", 22, bold);
  draw("PLACEHOLDER (Cloud Run worker)", 12, bold, muted);
  y -= 10;
  draw(`Generated: ${new Date().toISOString()}`);
  draw(`Inspection: ${inspectionId ?? "—"}`);
  draw(`Org: ${orgId ?? "—"}`);
  draw(`Job: ${jobId ?? "—"}`);
  y -= 10;
  draw("This mock confirms the report pipeline works end to end:", 11, font, muted);
  draw("app -> Cloud Run -> Storage + report_jobs -> Realtime.", 11, font, muted);
  draw("The real report rendering ports into this worker next.", 11, font, muted);

  return await pdf.save();
}
