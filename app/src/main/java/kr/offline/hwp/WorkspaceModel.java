package kr.offline.hwp;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Pure-Java document workspace model: ordered tabs (stable UUIDs), up to two visible panes (primary/secondary) and one active tab.
 * Holds no document content, paths or handles. Not thread-safe: use on the Activity UI thread only.
 * Unknown/malformed ids never throw and never mutate (the call returns false/null).
 */
public final class WorkspaceModel {
    public static final int MAX_TABS = 8;
    public static final int MAX_TITLE = 120;
    private static final Pattern UUID_RE = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    /** Canonical lowercase UUID string, or null if {@code id} is not a well-formed UUID. */
    public static String canonicalId(String id) {
        if (id == null || id.length() != 36 || !UUID_RE.matcher(id).matches()) return null;
        return id.toLowerCase(java.util.Locale.ROOT);
    }

    /** Immutable tab runtime view. */
    public static final class Tab {
        public final String id, title;
        public final boolean dirty, encrypted, ready;
        Tab(String id, String title, boolean dirty, boolean encrypted, boolean ready) {
            this.id = id; this.title = title; this.dirty = dirty; this.encrypted = encrypted; this.ready = ready;
        }
        Tab with(String t, boolean d, boolean e, boolean r) { return new Tab(id, t, d, e, r); }
        boolean same(Tab o) { return title.equals(o.title) && dirty == o.dirty && encrypted == o.encrypted && ready == o.ready; }
    }

    public enum SplitResult { CHANGED, UNCHANGED, NEEDS_NEW_TAB, REJECTED }

    /** Persisted/opaque layout value. Validation happens in {@link #restore}. */
    public static final class State {
        public final List<String> tabIds, recentIds;
        public final String activeId, primaryId, secondaryId;
        public final boolean split;
        public State(List<String> tabIds, String activeId, String primaryId, String secondaryId, boolean split, List<String> recentIds) {
            this.tabIds = Collections.unmodifiableList(new ArrayList<>(tabIds == null ? Collections.<String>emptyList() : tabIds));
            this.recentIds = Collections.unmodifiableList(new ArrayList<>(recentIds == null ? Collections.<String>emptyList() : recentIds));
            this.activeId = activeId; this.primaryId = primaryId; this.secondaryId = secondaryId; this.split = split;
        }
    }

    /** Immutable deep copy of the model for the JS/native protocol. */
    public static final class Snapshot {
        private final List<Tab> tabs;
        private final String activeId, primaryId, secondaryId;
        private final boolean split;
        Snapshot(List<Tab> tabs, String activeId, String primaryId, String secondaryId, boolean split) {
            this.tabs = Collections.unmodifiableList(new ArrayList<>(tabs));
            this.activeId = activeId; this.primaryId = primaryId; this.secondaryId = secondaryId; this.split = split;
        }
        public List<Tab> tabs() { return tabs; }
        public String activeId() { return activeId; }
        public String primaryId() { return primaryId; }
        public String secondaryId() { return secondaryId; }
        public boolean split() { return split; }
        public int maxTabs() { return MAX_TABS; }

        /** Unmodifiable JSON-ready structure: enabled,selfId,tabs[{id,title,dirty,encrypted,ready}],activeId,primaryId,secondaryId,split,maxTabs. */
        public Map<String, Object> toMap(String selfId) {
            List<Object> list = new ArrayList<>();
            for (Tab t : tabs) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", t.id); m.put("title", t.title); m.put("dirty", t.dirty); m.put("encrypted", t.encrypted); m.put("ready", t.ready);
                list.add(Collections.unmodifiableMap(m));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("enabled", Boolean.TRUE);
            out.put("selfId", selfId);
            out.put("tabs", Collections.unmodifiableList(list));
            out.put("activeId", activeId);
            out.put("primaryId", primaryId);
            out.put("secondaryId", secondaryId);
            out.put("split", split);
            out.put("maxTabs", MAX_TABS);
            return Collections.unmodifiableMap(out);
        }

        public String toJson(String selfId) { StringBuilder sb = new StringBuilder(); json(toMap(selfId), sb); return sb.toString(); }

        private static void json(Object v, StringBuilder sb) {
            if (v == null) sb.append("null");
            else if (v instanceof String) quote((String) v, sb);
            else if (v instanceof Map) {
                sb.append('{'); boolean first = true;
                for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                    if (!first) sb.append(','); first = false;
                    quote(String.valueOf(e.getKey()), sb); sb.append(':'); json(e.getValue(), sb);
                }
                sb.append('}');
            } else if (v instanceof List) {
                sb.append('['); boolean first = true;
                for (Object o : (List<?>) v) { if (!first) sb.append(','); first = false; json(o, sb); }
                sb.append(']');
            } else sb.append(v);
        }

        private static void quote(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    default:
                        // U+2028/2029 break JS string literals when the JSON is evaluated inline.
                        if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }

    private final List<Tab> tabs = new ArrayList<>();      // global order
    private final List<String> mru = new ArrayList<>();    // most recent first
    private String active, primary, secondary;
    private boolean split;
    private long revision;

    public WorkspaceModel() { }

    // ---------------------------------------------------------------- persistence

    public static WorkspaceModel restore(State s) {
        if (s == null) throw new IllegalArgumentException("state");
        if (s.tabIds.isEmpty() || s.tabIds.size() > MAX_TABS) throw new IllegalArgumentException("tab count");
        WorkspaceModel m = new WorkspaceModel();
        Set<String> seen = new HashSet<>();
        for (String raw : s.tabIds) {
            String id = canonicalId(raw);
            if (id == null || !raw.equals(id)) throw new IllegalArgumentException("tab id");
            if (!seen.add(id)) throw new IllegalArgumentException("duplicate tab id");
            m.tabs.add(new Tab(id, "", false, false, false));
        }
        String active = need(s.activeId, seen, "active");
        String primary = need(s.primaryId, seen, "primary");
        String secondary = null;
        if (s.secondaryId != null) {
            secondary = need(s.secondaryId, seen, "secondary");
            if (secondary.equals(primary)) throw new IllegalArgumentException("secondary == primary");
        }
        if (s.split != (secondary != null)) throw new IllegalArgumentException("split flag");
        if (!active.equals(primary) && !active.equals(secondary)) throw new IllegalArgumentException("active not visible");
        Set<String> recent = new HashSet<>();
        for (String raw : s.recentIds) {
            String id = need(raw, seen, "recent");
            if (!recent.add(id)) throw new IllegalArgumentException("duplicate recent id");
            m.mru.add(id);
        }
        // Supplied order is kept (active forced first); with no history the other visible pane follows; unseen tabs go last in global order.
        boolean hadHistory = !m.mru.isEmpty();
        m.mru.remove(active); m.mru.add(0, active);
        String other = active.equals(primary) ? secondary : primary;
        if (!hadHistory && other != null) { m.mru.remove(other); m.mru.add(1, other); }
        for (Tab t : m.tabs) if (!m.mru.contains(t.id)) m.mru.add(t.id);
        m.active = active; m.primary = primary; m.secondary = secondary; m.split = secondary != null;
        return m;
    }

    private static String need(String raw, Set<String> known, String what) {
        String id = canonicalId(raw);
        if (id == null || !raw.equals(id) || !known.contains(id)) throw new IllegalArgumentException(what);
        return id;
    }

    public State exportState() { return new State(tabIds(), active, primary, secondary, split, mru); }

    // ---------------------------------------------------------------- queries

    public int size() { return tabs.size(); }
    public boolean isEmpty() { return tabs.isEmpty(); }
    public boolean contains(String id) { return indexOf(id) >= 0; }
    public boolean canCreateTab() { return tabs.size() < MAX_TABS; }
    public List<String> tabIds() { List<String> o = new ArrayList<>(); for (Tab t : tabs) o.add(t.id); return Collections.unmodifiableList(o); }
    public Tab tab(String id) { int i = indexOf(id); return i < 0 ? null : tabs.get(i); }
    public String activeId() { return active; }
    public String primaryId() { return primary; }
    public String secondaryId() { return secondary; }
    public boolean isSplit() { return split; }
    public List<String> visibleIds() {
        List<String> o = new ArrayList<>();
        if (primary != null) o.add(primary);
        if (secondary != null) o.add(secondary);
        return Collections.unmodifiableList(o);
    }
    public boolean isVisible(String id) { String c = canonicalId(id); return c != null && (c.equals(primary) || c.equals(secondary)); }
    public List<String> recentIds() { return Collections.unmodifiableList(new ArrayList<>(mru)); }
    public long persistentRevision() { return revision; }

    public String adjacentId(String id, int delta) {
        int i = indexOf(id);
        if (i < 0 || tabs.size() < 2) return null;
        int n = tabs.size();
        int step = ((delta % n) + n) % n;
        if (step == 0) return null;
        return tabs.get((i + step) % n).id;
    }

    public Snapshot snapshot() { return new Snapshot(tabs, active, primary, secondary, split); }

    // ---------------------------------------------------------------- mutations

    public boolean createTab(UUID id) {
        if (id == null) throw new IllegalArgumentException("id");
        return createTab(id, active);
    }

    public boolean createTab(UUID uuid, String originId) {
        if (uuid == null) throw new IllegalArgumentException("id");
        String id = uuid.toString().toLowerCase(java.util.Locale.ROOT);
        if (tabs.size() >= MAX_TABS || contains(id)) return false;
        tabs.add(new Tab(id, "", false, false, false));
        if (tabs.size() == 1) {
            primary = id; secondary = null; split = false; active = id; touch(id);
        } else {
            showHidden(id, originId);
        }
        revision++;
        return true;
    }

    public boolean select(String targetId, String originId) {
        String t = canonicalId(targetId);
        if (t == null || !contains(t)) return false;
        if (t.equals(primary) || t.equals(secondary)) {
            if (t.equals(active)) return false;
            active = t; touch(t); revision++; return true;
        }
        showHidden(t, originId);
        revision++;
        return true;
    }

    public boolean setActive(String id) {
        String c = canonicalId(id);
        if (c == null || !contains(c) || !(c.equals(primary) || c.equals(secondary)) || c.equals(active)) return false;
        active = c; touch(c); revision++; return true;
    }

    public boolean removeConfirmed(String id) {
        int i = indexOf(id);
        if (i < 0) return false;
        String gone = tabs.get(i).id;
        tabs.remove(i);
        mru.remove(gone);
        if (tabs.isEmpty()) {
            active = primary = secondary = null; split = false;
        } else if (gone.equals(primary) || gone.equals(secondary)) {
            String hidden = mostRecentHidden();
            boolean wasActive = gone.equals(active);
            boolean wasPrimary = gone.equals(primary);
            if (hidden != null) {
                if (wasPrimary) primary = hidden; else secondary = hidden;
                if (wasActive) { active = hidden; touch(hidden); }
            } else {
                // no hidden tab left: collapse to the remaining pane (a split always has two distinct panes)
                String rest = wasPrimary ? secondary : primary;
                primary = rest; secondary = null; split = false; active = rest; touch(rest);
            }
        }
        revision++;
        return true;
    }

    public SplitResult setSplit(boolean enabled, String originId) {
        String origin = canonicalId(originId);
        if (origin == null || !contains(origin)) return SplitResult.REJECTED;
        if (enabled) {
            if (split) return SplitResult.UNCHANGED;
            String other = null;
            for (String id : mru) if (!id.equals(primary)) { other = id; break; }
            if (other == null) return SplitResult.NEEDS_NEW_TAB;
            secondary = other; split = true; revision++;
            return SplitResult.CHANGED;
        }
        if (!split) return SplitResult.UNCHANGED;
        primary = active; secondary = null; split = false; revision++;
        return SplitResult.CHANGED;
    }

    public boolean splitWithNewTab(UUID uuid, String originId) {
        if (uuid == null) throw new IllegalArgumentException("id");
        String origin = canonicalId(originId);
        String id = uuid.toString().toLowerCase(java.util.Locale.ROOT);
        if (origin == null || !contains(origin) || split || tabs.size() >= MAX_TABS || contains(id)) return false;
        tabs.add(new Tab(id, "", false, false, false));
        primary = origin.equals(primary) ? primary : origin;   // origin stays visible on the left
        secondary = id; split = true; active = id; touch(id);
        revision++;
        return true;
    }

    public boolean moveBefore(String id, String beforeIdOrNull) {
        int from = indexOf(id);
        if (from < 0) return false;
        int before = -1;
        if (beforeIdOrNull != null) {
            before = indexOf(beforeIdOrNull);
            if (before < 0 || before == from) return false;
        }
        int to = before < 0 ? tabs.size() - 1 : (before > from ? before - 1 : before);
        if (to == from) return false;
        Tab t = tabs.remove(from);
        tabs.add(to, t);
        revision++;
        return true;
    }

    public boolean update(String id, String title, boolean dirty, boolean encrypted, boolean ready) {
        int i = indexOf(id);
        if (i < 0) return false;
        Tab next = tabs.get(i).with(sanitize(title), dirty, encrypted, ready);
        if (next.same(tabs.get(i))) return false;
        tabs.set(i, next);
        return true;
    }

    // ---------------------------------------------------------------- internals

    private int indexOf(String id) {
        String c = canonicalId(id);
        if (c == null) return -1;
        for (int i = 0; i < tabs.size(); i++) if (tabs.get(i).id.equals(c)) return i;
        return -1;
    }

    private void touch(String id) { mru.remove(id); mru.add(0, id); }

    private String mostRecentHidden() {
        for (String id : mru) if (!id.equals(primary) && !id.equals(secondary)) return id;
        return null;
    }

    /** Show a hidden tab in origin's pane (the active pane if origin is not visible) and activate it. */
    private void showHidden(String id, String originId) {
        String origin = canonicalId(originId);
        boolean replaceSecondary;
        if (origin != null && origin.equals(secondary)) replaceSecondary = true;
        else if (origin != null && origin.equals(primary)) replaceSecondary = false;
        else replaceSecondary = split && active != null && active.equals(secondary);
        if (replaceSecondary) secondary = id; else primary = id;
        active = id; touch(id);
    }

    static String sanitize(String title) {
        if (title == null) return "";
        StringBuilder sb = new StringBuilder();
        int count = 0;
        for (int i = 0; i < title.length() && count < MAX_TITLE; ) {
            int cp = title.codePointAt(i); i += Character.charCount(cp);
            int type = Character.getType(cp);
            if (type == Character.CONTROL || type == Character.FORMAT || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR
                    || type == Character.SURROGATE || type == Character.UNASSIGNED || type == Character.PRIVATE_USE) cp = ' ';
            sb.appendCodePoint(cp); count++;
        }
        return sb.toString().trim();
    }
}
