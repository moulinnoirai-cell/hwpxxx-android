package kr.offline.hwp;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InterruptedIOException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.InflaterInputStream;

public class RasterPdfTest {
    private static int checks;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    public static void main(String[] args) throws Exception {
        List<int[]> all = PrintPageRanges.normalize(new int[][]{{0, Integer.MAX_VALUE}}, 121);
        check(all.size() == 1 && Arrays.equals(all.get(0), new int[]{0, 120}), "ALL_PAGES clipped to true count");
        List<int[]> ranges = PrintPageRanges.normalize(new int[][]{{120, 150}, {102, 110}, {99, 101},
                {1, 2}, {105, 108}, {111, 119}, {122, 130}}, 121);
        check(ranges.size() == 2 && Arrays.equals(ranges.get(0), new int[]{1, 2})
                && Arrays.equals(ranges.get(1), new int[]{99, 120}), "sort, clip, merge, and deduplicate");
        check(PrintPageRanges.normalize(new int[][]{{121, 125}}, 121).isEmpty(), "entirely out of range");

        RasterPdf.Box paper = new RasterPdf.Box(18, 25, 560, 780);
        RasterPdf.Box portrait = paper.fit(700, 1400), landscape = paper.fit(1400, 700);
        check(portrait.x == 103 && portrait.y == 25 && portrait.width == 390 && portrait.height == 780, "portrait centered");
        check(landscape.x == 18 && landscape.y == 275 && landscape.width == 560 && landscape.height == 280, "landscape centered");

        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AtomicInteger rows = new AtomicInteger();
        try (RasterPdf pdf = new RasterPdf(output, Long.MAX_VALUE)) {
            for (int[] range : ranges) {
                for (int index = range[0]; index <= range[1]; index++) {
                    pdf.addPage(595 + index, 842, paper, 2, 2, (y, data) -> {
                        rows.incrementAndGet();
                        data[0] = y == 0 ? 0xffff0000 : 0xff0000ff;
                        data[1] = y == 0 ? 0x00000000 : 0x80000000;
                    }, () -> false);
                }
            }
            check(rows.get() == 48 && output.size() > 0, "24 selected pages are streamed row by row before finish");
            pdf.finish(() -> false);
        }
        byte[] bytes = output.toByteArray();
        String text = new String(bytes, StandardCharsets.ISO_8859_1);
        check(text.startsWith("%PDF-1.4") && text.endsWith("%%EOF\n"), "PDF envelope");
        check(text.contains("/Count 24 /Kids [") && !text.contains("/MediaBox [0 0 598 842]")
                && text.indexOf("/MediaBox [0 0 596 842]") < text.indexOf("/MediaBox [0 0 715 842]"), "selected page tree and order");
        int firstStream = text.indexOf("\nstream\n") + "\nstream\n".length();
        int end = text.indexOf("\nendstream", firstStream);
        byte[] predicted;
        try (InflaterInputStream stream = new InflaterInputStream(new ByteArrayInputStream(bytes, firstStream, end - firstStream))) {
            predicted = FileStore.bounded(stream, 100);
        }
        check(Arrays.equals(predicted, new byte[]{2, -1, 0, 0, -1, -1, -1, 2, 1, 0, -1, -128, -128, -128}),
                "lossless RGB scanlines, white alpha compositing, PNG Up filter");
        int xref = Integer.parseInt(text.substring(text.lastIndexOf("startxref\n") + "startxref\n".length(), text.lastIndexOf("\n%%EOF")));
        String[] entries = text.substring(xref).split("\n");
        check(entries[0].equals("xref") && entries[1].equals("0 99"), "xref location and size");
        for (int id = 1; id < 99; id++) {
            int offset = Integer.parseInt(entries[id + 2].substring(0, 10));
            check(text.startsWith(id + " 0 obj\n", offset), "xref object " + id);
        }
        try (RasterPdf pdf = new RasterPdf(new ByteArrayOutputStream(), Long.MAX_VALUE)) {
            for (int index = 0; index < 121; index++) {
                pdf.addPage(595, 842, paper, 1, 1, (y, row) -> row[0] = -1, () -> false);
            }
            pdf.finish(() -> false);
        }
        checks++;
        try (RasterPdf pdf = new RasterPdf(new ByteArrayOutputStream(), 20)) {
            pdf.addPage(595, 842, paper, 1, 1, (y, row) -> row[0] = -1, () -> false);
            throw new AssertionError("output limit should stop the write");
        } catch (IOException expected) { checks++; }
        try (RasterPdf pdf = new RasterPdf(new ByteArrayOutputStream(), Long.MAX_VALUE)) {
            AtomicInteger read = new AtomicInteger();
            pdf.addPage(595, 842, paper, 1, 5, (y, row) -> read.incrementAndGet(), () -> read.get() == 1);
            throw new AssertionError("cancellation should stop at the next row");
        } catch (InterruptedIOException expected) { checks++; }
        System.out.println("RasterPdf: " + checks + " checks passed");
    }
}
