import android.content.Context;
import android.content.Intent;
import java.lang.reflect.Method;

/** Test tool: delivers one SMS (as the radio would: an SMS_RECEIVED broadcast with a real 3GPP PDU) to one package, from app_process as root.
 *  Used because this emulator's modem is not available (RADIO_NOT_AVAILABLE). args: pkg from slot text... */
public class SendSms {
    static byte[] septets(String s) {
        int n = s.length(), bits = n * 7, bytes = (bits + 7) / 8;
        byte[] out = new byte[bytes];
        for (int i = 0; i < n; i++) {
            int c = s.charAt(i) & 0x7f;
            int bit = i * 7, idx = bit / 8, off = bit % 8;
            out[idx] |= (byte) (c << off);
            if (off > 1 && idx + 1 < bytes) out[idx + 1] |= (byte) (c >> (8 - off));
        }
        return out;
    }
    static byte[] pdu(String from, String text) {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        o.write(0x00);                       // no SMSC
        o.write(0x04);                       // SMS-DELIVER
        boolean alpha = !from.matches("[+0-9]+");
        if (alpha) {
            byte[] a = septets(from);
            o.write((from.length() * 7 + 3) / 4);   // address length in semi-octets
            o.write(0xD0);                           // alphanumeric
            o.write(a, 0, a.length);
        } else {
            String d = from.replace("+", "");
            o.write(d.length()); o.write(from.startsWith("+") ? 0x91 : 0x81);
            for (int i = 0; i < d.length(); i += 2) { int lo = d.charAt(i) - '0', hi = i + 1 < d.length() ? d.charAt(i + 1) - '0' : 0xF; o.write((hi << 4) | lo); }
        }
        o.write(0x00); o.write(0x00);        // PID, DCS (GSM 7-bit)
        byte[] ts = {0x62, 0x11, 0x62, 0x31, 0x00, 0x00, 0x00};   // 26-11-26 13:00:00
        o.write(ts, 0, 7);
        o.write(text.length());              // UDL in septets
        byte[] u = septets(text);
        o.write(u, 0, u.length);
        return o.toByteArray();
    }
    public static void main(String[] a) throws Exception {
        String pkg = a[0], from = a[1], text = a[3];
        int slot = Integer.parseInt(a[2]);
        Intent i = new Intent("android.provider.Telephony.SMS_RECEIVED");
        i.setPackage(pkg);
        i.putExtra("pdus", new Object[]{pdu(from, text)});
        i.putExtra("format", "3gpp");
        i.putExtra("slot", slot);
        i.putExtra("android.telephony.extra.SLOT_INDEX", slot);
        Object am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
        Method m = null;
        for (Method x : am.getClass().getMethods()) if (x.getName().equals("broadcastIntentWithFeature")) m = x;
        if (m == null) throw new RuntimeException("no broadcastIntentWithFeature");
        Class<?>[] t = m.getParameterTypes();
        Object[] args = new Object[t.length];
        int[] ints = {0, -1, 0};
        int ni = 0;
        for (int k = 0; k < t.length; k++) {
            if (t[k] == Intent.class) args[k] = i;
            else if (t[k] == int.class) args[k] = ints[Math.min(ni++, 2)];
            else if (t[k] == boolean.class) args[k] = false;
            else args[k] = null;
        }
        Object r = m.invoke(am, args);
        System.out.println("sent " + System.currentTimeMillis());
        Thread.sleep(500);
        System.exit(0);
    }
}
