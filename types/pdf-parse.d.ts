declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  function pdf(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdf;
}
