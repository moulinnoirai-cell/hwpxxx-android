package kr.offline.hwp;

import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.util.Base64;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

final class RasterPrintAdapter extends PrintDocumentAdapter {
    interface Events {
        void send(String name, Object... fields);
        void finished(RasterPrintAdapter adapter);
    }

    private static final class Layout {
        final int width, height, dpi;
        final RasterPdf.Box printable;

        Layout(PrintAttributes attributes) throws IOException {
            PrintAttributes.MediaSize media = attributes.getMediaSize();
            if (media == null || PrintAttributes.MediaSize.UNKNOWN_PORTRAIT.equals(media)) {
                media = PrintAttributes.MediaSize.ISO_A4;
            } else if (PrintAttributes.MediaSize.UNKNOWN_LANDSCAPE.equals(media)) {
                media = PrintAttributes.MediaSize.ISO_A4.asLandscape();
            }
            PrintAttributes.Margins margins = attributes.getMinMargins();
            if (margins == null) margins = PrintAttributes.Margins.NO_MARGINS;
            PrintAttributes.Resolution resolution = attributes.getResolution();
            dpi = resolution == null ? 300 : Math.min(resolution.getHorizontalDpi(), resolution.getVerticalDpi());
            width = (int) Math.round(media.getWidthMils() * .072);
            height = (int) Math.round(media.getHeightMils() * .072);
            int left = marginPoints(margins.getLeftMils());
            int right = marginPoints(margins.getRightMils());
            int top = marginPoints(margins.getTopMils());
            int bottom = marginPoints(margins.getBottomMils());
            if (width <= left + right || height <= bottom + top) throw new IOException("인쇄할 용지 여백을 확인해 주세요.");
            printable = new RasterPdf.Box(left, bottom, width - left - right, height - bottom - top);
        }

        private static int marginPoints(int mils) {
            return (int) Math.ceil(mils * .072);
        }
    }

    static final class PageTransfer {
        final String token = UUID.randomUUID().toString();
        private final CompletableFuture<PageData> result = new CompletableFuture<>();
        private byte[] png;
        private int position, sequence;
        private double width, height;

        synchronized void begin(int length, double width, double height) throws IOException {
            if (result.isDone() || png != null) throw stalePage();
            if (length < 8 || length > RasterPdfPage.MAX_PNG_BYTES
                    || !Double.isFinite(width) || !Double.isFinite(height) || width <= 0 || height <= 0) {
                throw new IOException("인쇄 쪽 이미지의 크기가 올바르지 않아요.");
            }
            this.width = width;
            this.height = height;
            png = new byte[length];
        }

        synchronized void chunk(int index, String encoded) throws IOException {
            if (result.isDone() || png == null) throw stalePage();
            if (index != sequence || encoded.length() > 350000) throw new IOException("인쇄 조각의 순서가 올바르지 않아요.");
            byte[] part = Base64.decode(encoded, Base64.DEFAULT);
            if (part.length == 0 || part.length > png.length - position) throw new IOException("인쇄 조각의 크기가 올바르지 않아요.");
            System.arraycopy(part, 0, png, position, part.length);
            position += part.length;
            sequence++;
        }

        void fail(Throwable error) {
            result.completeExceptionally(error);
        }

        synchronized void finish() throws IOException {
            if (result.isDone() || png == null) throw stalePage();
            if (position != png.length) throw new IOException("인쇄 쪽 데이터가 일치하지 않아요.");
            result.complete(new PageData(png, width, height));
            png = null;
        }
    }

    private static final class PageData {
        final byte[] png;
        final double width, height;

        PageData(byte[] png, double width, double height) {
            this.png = png;
            this.width = width;
            this.height = height;
        }
    }

    private final long job;
    private final int pageCount;
    private final Events events;
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private volatile PageTransfer pending;
    private volatile boolean closed;
    private Layout layout;

    RasterPrintAdapter(long job, int pageCount, Events events) {
        this.job = job;
        this.pageCount = pageCount;
        this.events = events;
    }

    PageTransfer requirePage(String token) throws IOException {
        PageTransfer page = pending;
        if (page == null || !page.token.equals(token) || page.result.isDone()) throw stalePage();
        return page;
    }

    static IOException stalePage() {
        return new IOException("인쇄 쪽 요청이 끝났어요.");
    }

    @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
                                   CancellationSignal cancellation, LayoutResultCallback callback, Bundle extras) {
        if (closed || cancellation.isCanceled()) {
            callback.onLayoutCancelled();
            return;
        }
        try {
            layout = new Layout(newAttributes);
            callback.onLayoutFinished(new PrintDocumentInfo.Builder("hwpxxx.pdf")
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).setPageCount(pageCount).build(),
                    !newAttributes.equals(oldAttributes));
        } catch (IOException error) {
            callback.onLayoutFailed(error.getMessage());
        }
    }

    @Override public void onWrite(PageRange[] requested, ParcelFileDescriptor destination,
                                  CancellationSignal cancellation, WriteResultCallback callback) {
        Layout current = layout;
        try {
            writer.execute(() -> write(requested, destination, cancellation, callback, current));
        } catch (RejectedExecutionException closing) {
            try { destination.close(); } catch (IOException ignored) { }
            callback.onWriteCancelled();
        }
    }

    private void write(PageRange[] requested, ParcelFileDescriptor destination, CancellationSignal cancellation,
                       WriteResultCallback callback, Layout current) {
        BooleanSupplier cancelled = () -> closed || cancellation.isCanceled();
        cancellation.setOnCancelListener(this::cancelPending);
        PageRange[] written = null;
        String failure = null;
        try (RasterPdf pdf = new RasterPdf(new BufferedOutputStream(
                new ParcelFileDescriptor.AutoCloseOutputStream(destination)), Long.MAX_VALUE)) {
            if (cancelled.getAsBoolean()) throw new InterruptedIOException();
            if (current == null) throw new IOException("인쇄 설정을 확인하지 못했어요.");
            int[][] bounds = new int[requested.length][2];
            for (int i = 0; i < requested.length; i++) {
                bounds[i][0] = requested[i].getStart();
                bounds[i][1] = requested[i].getEnd();
            }
            List<int[]> ranges = PrintPageRanges.normalize(bounds, pageCount);
            if (ranges.isEmpty()) throw new IOException("인쇄할 쪽 범위가 없어요.");
            written = new PageRange[ranges.size()];
            for (int i = 0; i < ranges.size(); i++) {
                int[] range = ranges.get(i);
                for (int index = range[0]; index <= range[1]; index++) {
                    PageData page = renderPage(index, current, cancelled);
                    RasterPdfPage.write(pdf, page.png, current.width, current.height,
                            current.printable.fit(page.width, page.height), cancelled);
                }
                written[i] = new PageRange(range[0], range[1]);
            }
            pdf.finish(cancelled);
        } catch (Exception error) {
            failure = error.getMessage() == null ? "인쇄 자료를 만들지 못했어요." : error.getMessage();
        } catch (OutOfMemoryError exhausted) {
            failure = "메모리가 부족해 인쇄 자료를 만들지 못했어요.";
        } finally {
            cancellation.setOnCancelListener(null);
        }
        if (cancelled.getAsBoolean()) callback.onWriteCancelled();
        else if (failure != null) callback.onWriteFailed(failure);
        else callback.onWriteFinished(written);
    }

    private PageData renderPage(int index, Layout current, BooleanSupplier cancelled) throws IOException {
        PageTransfer page = new PageTransfer();
        pending = page;
        try {
            if (cancelled.getAsBoolean()) throw new InterruptedIOException();
            events.send("printPage", "job", job, "token", page.token, "index", index,
                    "widthPt", current.printable.width, "heightPt", current.printable.height, "dpi", current.dpi);
            return page.result.get(60, TimeUnit.SECONDS);
        } catch (CancellationException | InterruptedException stopped) {
            throw new InterruptedIOException();
        } catch (TimeoutException timeout) {
            throw new IOException((index + 1) + "쪽을 준비하는 데 시간이 너무 오래 걸렸어요.");
        } catch (ExecutionException failure) {
            throw new IOException(failure.getCause().getMessage(), failure.getCause());
        } finally {
            pending = null;
            if (page.result.cancel(false) || cancelled.getAsBoolean()) {
                events.send("printPageCancelled", "job", job, "token", page.token);
            }
        }
    }

    private void cancelPending() {
        PageTransfer page = pending;
        if (page != null) page.result.cancel(false);
    }

    void close() {
        closed = true;
        cancelPending();
        writer.shutdown();
    }

    @Override public void onFinish() {
        close();
        events.finished(this);
    }
}
