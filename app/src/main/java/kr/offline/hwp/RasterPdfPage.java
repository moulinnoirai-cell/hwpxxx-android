package kr.offline.hwp;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.function.BooleanSupplier;

final class RasterPdfPage {
    static final int MAX_PNG_BYTES = 8 * 1024 * 1024;
    private static final int MAX_PIXELS = 5_000_000;
    private static final int MAX_EDGE = 4096;

    static void write(RasterPdf pdf, byte[] png, int paperWidth, int paperHeight, RasterPdf.Box box,
                      BooleanSupplier cancelled) throws IOException {
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(png, 0, png.length, opts);
        if (!"image/png".equals(opts.outMimeType) || opts.outWidth < 1 || opts.outHeight < 1
                || opts.outWidth > MAX_EDGE || opts.outHeight > MAX_EDGE
                || (long) opts.outWidth * opts.outHeight > MAX_PIXELS) {
            throw new IOException("PNG 이미지 형식이 올바르지 않거나 크기가 너무 커요.");
        }
        if (cancelled.getAsBoolean()) throw new InterruptedIOException();
        opts.inJustDecodeBounds = false;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeByteArray(png, 0, png.length, opts);
        if (bitmap == null) throw new IOException("PDF 이미지를 읽지 못했어요.");
        try {
            int width = bitmap.getWidth();
            pdf.addPage(paperWidth, paperHeight, box, width, bitmap.getHeight(),
                    (y, row) -> bitmap.getPixels(row, 0, width, 0, y, width, 1), cancelled);
        } finally {
            bitmap.recycle();
        }
    }
}
