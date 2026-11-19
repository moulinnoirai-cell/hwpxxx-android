package kr.offline.hwp;

import java.io.Closeable;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;

/** A lossless, sequential PDF writer for one RGB image per page. Only object offsets survive a page. */
final class RasterPdf implements Closeable {
    @FunctionalInterface
    interface RowReader {
        void read(int y, int[] argb);
    }

    static final class Box {
        final int x, y, width, height;

        Box(int x, int y, int width, int height) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }

        Box fit(double sourceWidth, double sourceHeight) {
            double scale = Math.min(width / sourceWidth, height / sourceHeight);
            int w = Math.max(1, (int) Math.round(sourceWidth * scale));
            int h = Math.max(1, (int) Math.round(sourceHeight * scale));
            return new Box(x + (width - w) / 2, y + (height - h) / 2, w, h);
        }
    }

    private static final int FIRST_PAGE = 3;
    private static final int OBJECTS_PER_PAGE = 4;
    private final OutputStream output;
    private final long limit;
    private final List<Long> offsets = new ArrayList<>();
    private long position;
    private int pages;

    RasterPdf(OutputStream output, long limit) {
        this.output = output;
        this.limit = Math.min(limit, 9_999_999_999L); // classic xref entries have ten digits
        for (int i = 0; i < FIRST_PAGE; i++) offsets.add(0L);
    }

    void addPage(int width, int height, Box image, int pixelsWide, int pixelsHigh,
                 RowReader readRow, BooleanSupplier cancelled) throws IOException {
        checkCancelled(cancelled);
        if (pages == 0) {
            ascii("%PDF-1.4\n");
            byte[] marker = {'%', (byte) 226, (byte) 227, (byte) 207, (byte) 211, '\n'};
            write(marker, 0, marker.length);
            object(1, "<< /Type /Catalog /Pages 2 0 R >>");
        }
        int page = FIRST_PAGE + pages * OBJECTS_PER_PAGE;
        for (int i = 0; i < OBJECTS_PER_PAGE; i++) offsets.add(0L);
        int picture = page + 1, length = page + 2, content = page + 3;
        object(page, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + width + " " + height
                + "] /Resources << /XObject << /Im " + picture + " 0 R >> >> /Contents " + content + " 0 R >>");
        startObject(picture);
        ascii("<< /Type /XObject /Subtype /Image /Width " + pixelsWide + " /Height " + pixelsHigh
                + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode"
                + " /DecodeParms << /Predictor 12 /Colors 3 /Columns " + pixelsWide + " >>"
                + " /Length " + length + " 0 R >>\nstream\n");
        long start = position;
        writeImage(pixelsWide, pixelsHigh, readRow, cancelled);
        long imageLength = position - start;
        ascii("\nendstream\nendobj\n");
        object(length, Long.toString(imageLength));
        String commands = "q\n" + image.width + " 0 0 " + image.height + " " + image.x + " " + image.y
                + " cm\n/Im Do\nQ\n";
        object(content, "<< /Length " + commands.length() + " >>\nstream\n" + commands + "endstream");
        pages++;
    }

    private void writeImage(int width, int height, RowReader readRow,
                            BooleanSupplier cancelled) throws IOException {
        int[] argb = new int[width];
        byte[] previous = new byte[width * 3], row = new byte[1 + width * 3];
        row[0] = 2; // PNG Up predictor, including the per-row filter byte
        Deflater deflater = new Deflater(Deflater.BEST_SPEED);
        try {
            OutputStream counted = new OutputStream() {
                @Override public void write(int value) throws IOException {
                    write(new byte[]{(byte) value}, 0, 1);
                }
                @Override public void write(byte[] bytes, int offset, int size) throws IOException {
                    RasterPdf.this.write(bytes, offset, size);
                }
            };
            DeflaterOutputStream compressed = new DeflaterOutputStream(counted, deflater, 8192);
            for (int y = 0; y < height; y++) {
                checkCancelled(cancelled);
                readRow.read(y, argb);
                for (int x = 0, i = 0; x < width; x++) {
                    int pixel = argb[x], alpha = pixel >>> 24;
                    for (int shift = 16; shift >= 0; shift -= 8, i++) {
                        int channel = (pixel >>> shift) & 255;
                        int value = alpha == 255 ? channel : 255 - ((255 - channel) * alpha + 127) / 255;
                        row[i + 1] = (byte) (value - previous[i]);
                        previous[i] = (byte) value;
                    }
                }
                compressed.write(row);
            }
            compressed.finish();
        } finally {
            deflater.end();
        }
    }

    void finish(BooleanSupplier cancelled) throws IOException {
        checkCancelled(cancelled);
        if (pages == 0) throw new IOException("PDF에 기록할 쪽이 없어요.");
        startObject(2);
        ascii("<< /Type /Pages /Count " + pages + " /Kids [\n");
        for (int i = 0; i < pages; i++) {
            checkCancelled(cancelled);
            ascii((FIRST_PAGE + i * OBJECTS_PER_PAGE) + " 0 R\n");
        }
        ascii("] >>\nendobj\n");
        long xref = position;
        ascii("xref\n0 " + offsets.size() + "\n0000000000 65535 f \n");
        for (int i = 1; i < offsets.size(); i++) {
            checkCancelled(cancelled);
            String offset = Long.toString(offsets.get(i));
            ascii("0000000000".substring(offset.length()) + offset + " 00000 n \n");
        }
        ascii("trailer\n<< /Size " + offsets.size() + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
        output.flush();
    }

    private static void checkCancelled(BooleanSupplier cancelled) throws IOException {
        if (cancelled.getAsBoolean()) throw new InterruptedIOException("PDF 작업을 취소했어요.");
    }

    private void startObject(int id) throws IOException {
        offsets.set(id, position);
        ascii(id + " 0 obj\n");
    }

    private void object(int id, String body) throws IOException {
        startObject(id);
        ascii(body + "\nendobj\n");
    }

    private void ascii(String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.US_ASCII);
        write(bytes, 0, bytes.length);
    }

    private void write(byte[] bytes, int offset, int size) throws IOException {
        if (size > limit - position) {
            throw new IOException(limit == FileStore.MAX_BYTES ? "PDF가 32MB를 넘어요." : "PDF 결과가 너무 커요.");
        }
        output.write(bytes, offset, size);
        position += size;
    }

    @Override public void close() throws IOException {
        output.close();
    }
}
