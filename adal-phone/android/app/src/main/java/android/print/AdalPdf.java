package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import java.io.File;

/**
 * A page printed straight into a PDF file, without Android's print screen
 * (the phone makes a CV's PDF itself when the office PC is off). Android's
 * print callbacks can only be made from inside android.print, hence here.
 */
public final class AdalPdf {
    public interface Done { void ok(File pdf); void fail(String why); }

    public static void write(final PrintDocumentAdapter a, PrintAttributes attrs, final File out, final Done done) {
        a.onStart();
        a.onLayout(null, attrs, new CancellationSignal(), new PrintDocumentAdapter.LayoutResultCallback() {
            @Override public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                try {
                    final ParcelFileDescriptor fd = ParcelFileDescriptor.open(out, ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_READ_WRITE);
                    a.onWrite(new PageRange[] { PageRange.ALL_PAGES }, fd, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                        @Override public void onWriteFinished(PageRange[] pages) { close(fd); a.onFinish(); done.ok(out); }
                        @Override public void onWriteFailed(CharSequence error) { close(fd); a.onFinish(); done.fail(String.valueOf(error)); }
                        @Override public void onWriteCancelled() { close(fd); a.onFinish(); done.fail("cancelled"); }
                    });
                } catch (Exception e) { done.fail(e.getMessage()); }
            }
            @Override public void onLayoutFailed(CharSequence error) { done.fail(String.valueOf(error)); }
            @Override public void onLayoutCancelled() { done.fail("cancelled"); }
        }, null);
    }

    private static void close(ParcelFileDescriptor fd) { try { fd.close(); } catch (Exception ignored) { } }
}
