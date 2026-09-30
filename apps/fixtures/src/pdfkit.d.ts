declare module 'pdfkit' {
  import { Writable } from 'stream';
  class PDFDocument extends Writable {
    constructor(options?: Record<string, unknown>);
    fontSize(size: number): this;
    text(text: string, options?: Record<string, unknown>): this;
    moveDown(lines?: number): this;
    list(items: string[]): this;
    end(): void;
  }
  export default PDFDocument;
}