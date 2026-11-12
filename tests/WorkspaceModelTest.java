package kr.offline.hwp;

import java.util.*;

/** JVM tests of the pure-Java workspace model. Synthetic ids/titles only. */
public class WorkspaceModelTest {
    static int checks = 0;
    static void yes(boolean ok, String what) { if (!ok) throw new AssertionError(what); checks++; }
    static void eq(Object a, Object b, String what) { yes(Objects.equals(a, b), what + " expected=" + b + " actual=" + a); }
    static UUID u(int n) { return new UUID(0xabcdef0123456789L, 0x8000000000000000L | n); }
    static String id(int n) { return u(n).toString(); }

    /** Cross-field invariants that must hold after every operation. */
    static void invariants(WorkspaceModel m, String when) {
        List<String> ids = m.tabIds();
        eq(new HashSet<>(ids).size(), ids.size(), when + ": unique ids");
        yes(ids.size() <= WorkspaceModel.RESTORE_MAX_TABS, when + ": cap");
        if (m.isEmpty()) { yes(m.activeId() == null && m.primaryId() == null && m.secondaryId() == null && !m.isSplit(), when + ": empty clean"); return; }
        yes(m.contains(m.primaryId()) && m.contains(m.activeId()), when + ": primary/active exist");
        yes(m.isVisible(m.activeId()), when + ": active visible");
        if (m.isSplit()) { yes(m.secondaryId() != null && m.contains(m.secondaryId()) && !m.secondaryId().equals(m.primaryId()), when + ": split panes distinct"); }
        else yes(m.secondaryId() == null, when + ": no secondary when single");
        eq(m.visibleIds().size(), m.isSplit() ? 2 : 1, when + ": visible count");
        eq(new HashSet<>(m.recentIds()), new HashSet<>(ids), when + ": mru covers tabs");
        eq(m.recentIds().get(0), m.activeId(), when + ": mru head is active");
        WorkspaceModel r = WorkspaceModel.restore(m.exportState());
        eq(r.tabIds(), ids, when + ": exportState round trip order");
        eq(r.activeId(), m.activeId(), when + ": round trip active");
        eq(r.primaryId() + "/" + r.secondaryId(), m.primaryId() + "/" + m.secondaryId(), when + ": round trip panes");
    }

    static WorkspaceModel three() {
        WorkspaceModel m = new WorkspaceModel();
        for (int i = 1; i <= 3; i++) { yes(m.createTab(u(i)), "create " + i); invariants(m, "create " + i); }
        return m;
    }

    static void createAndSelect() {
        WorkspaceModel m = new WorkspaceModel();
        yes(m.isEmpty() && m.snapshot().tabs().isEmpty() && m.snapshot().activeId() == null, "starts empty");
        yes(m.createTab(u(1)), "first tab");
        eq(m.primaryId(), id(1), "first primary"); eq(m.activeId(), id(1), "first active"); yes(!m.isSplit(), "single");
        yes(!m.createTab(u(1)), "duplicate id rejected"); eq(m.size(), 1, "duplicate no change");
        yes(m.createTab(u(2)), "second"); yes(m.createTab(u(3)), "third");
        eq(m.tabIds(), Arrays.asList(id(1), id(2), id(3)), "global order is creation order");
        eq(m.primaryId(), id(3), "new tab replaces origin pane"); eq(m.activeId(), id(3), "new tab active");
        yes(!m.isVisible(id(1)) && !m.isVisible(id(2)), "older tabs hidden but alive");
        yes(m.select(id(1), id(3)), "select hidden"); eq(m.primaryId(), id(1), "replaces origin pane");
        eq(m.activeId(), id(1), "selected active"); invariants(m, "select hidden");
        long rev = m.persistentRevision();
        yes(!m.select(id(1), id(1)), "reselect active is no-op"); eq(m.persistentRevision(), rev, "no revision bump on no-op");
        yes(!m.select(id(9), id(1)) && !m.select("garbage", id(1)) && !m.select(null, id(1)), "unknown target");
        eq(m.activeId(), id(1), "unknown target no mutation");
        yes(m.select(id(2).toUpperCase(), id(1).toUpperCase()), "uppercase ids accepted"); eq(m.activeId(), id(2), "normalised id");
    }

    static void splitSwapFocusCollapse() {
        WorkspaceModel m = three();                      // primary=3, hidden 1,2 ; mru 3,2,1
        eq(m.setSplit(true, id(3)), WorkspaceModel.SplitResult.CHANGED, "split enabled");
        eq(m.primaryId(), id(3), "primary kept"); eq(m.secondaryId(), id(2), "other = most recent"); eq(m.activeId(), id(3), "focus unchanged");
        invariants(m, "split on");
        eq(m.setSplit(true, id(3)), WorkspaceModel.SplitResult.UNCHANGED, "second enable no-op");
        // selecting a tab already visible in the other pane focuses it, never duplicates
        yes(m.select(id(2), id(3)), "focus other pane"); eq(m.activeId(), id(2), "other pane focused");
        eq(m.primaryId(), id(3), "primary unchanged"); eq(m.secondaryId(), id(2), "secondary unchanged"); invariants(m, "focus other");
        yes(!m.select(id(2), id(3)), "already focused");
        // hidden tab replaces ORIGIN pane (secondary), primary untouched
        yes(m.select(id(1), id(2)), "hidden replaces origin pane"); eq(m.secondaryId(), id(1), "secondary replaced"); eq(m.primaryId(), id(3), "primary untouched");
        eq(m.activeId(), id(1), "new active"); yes(m.contains(id(2)) && !m.isVisible(id(2)), "replaced doc retained hidden");
        invariants(m, "replace secondary");
        // origin = primary session selecting hidden doc 2: replaces primary, secondary stays
        yes(m.select(id(2), id(3)), "primary session replaces own pane"); eq(m.primaryId(), id(2), "primary replaced"); eq(m.secondaryId(), id(1), "secondary kept");
        yes(m.setActive(id(1)) , "setActive visible"); eq(m.activeId(), id(1), "setActive"); yes(!m.setActive(id(3)), "setActive hidden refused");
        eq(m.activeId(), id(1), "hidden setActive no mutation");
        eq(m.setSplit(false, id(1)), WorkspaceModel.SplitResult.CHANGED, "collapse");
        eq(m.primaryId(), id(1), "collapse keeps active doc"); yes(m.secondaryId() == null && !m.isSplit(), "single again");
        eq(new HashSet<>(m.tabIds()), new HashSet<>(Arrays.asList(id(1), id(2), id(3))), "collapse keeps every tab");
        yes(m.contains(id(2)) && m.contains(id(3)), "former panes retained hidden"); invariants(m, "collapse");
        eq(m.setSplit(false, id(1)), WorkspaceModel.SplitResult.UNCHANGED, "collapse twice");
        eq(m.setSplit(true, "nope"), WorkspaceModel.SplitResult.REJECTED, "unknown origin rejected");
    }

    static void splitNeedsNewTab() {
        WorkspaceModel m = new WorkspaceModel(); m.createTab(u(1));
        long rev = m.persistentRevision();
        eq(m.setSplit(true, id(1)), WorkspaceModel.SplitResult.NEEDS_NEW_TAB, "lone tab needs new tab");
        eq(m.persistentRevision(), rev, "NEEDS_NEW_TAB does not mutate"); yes(!m.isSplit(), "still single");
        yes(!m.splitWithNewTab(u(2), "nope"), "unknown origin refused"); eq(m.size(), 1, "refused adds nothing");
        yes(m.splitWithNewTab(u(2), id(1)), "split with new tab");
        eq(m.primaryId(), id(1), "origin stays left"); eq(m.secondaryId(), id(2), "new tab right"); eq(m.activeId(), id(2), "new tab focused");
        yes(m.isSplit(), "split"); invariants(m, "splitWithNewTab");
        yes(!m.splitWithNewTab(u(3), id(1)), "already split refused"); eq(m.size(), 2, "no extra tab");
        yes(!m.splitWithNewTab(u(2), id(1)), "duplicate refused");
    }

    static void reorder() {
        WorkspaceModel m = three();
        yes(m.createTab(u(4)), "4th");
        yes(m.setSplit(true, id(4)) == WorkspaceModel.SplitResult.CHANGED, "split"); m.select(id(1), id(4));
        m.update(id(2), "문서 둘", true, true, true); m.update(id(3), "three", false, false, true);
        String active = m.activeId(), pri = m.primaryId(), sec = m.secondaryId(); List<String> mru = m.recentIds();
        WorkspaceModel.Tab t2 = m.tab(id(2)), t3 = m.tab(id(3));
        long rev = m.persistentRevision();
        yes(m.moveBefore(id(4), id(1)), "move 4 before 1"); eq(m.tabIds(), Arrays.asList(id(4), id(1), id(2), id(3)), "order after move");
        yes(m.persistentRevision() > rev, "reorder is persistable");
        eq(m.activeId(), active, "active unchanged"); eq(m.primaryId(), pri, "primary unchanged"); eq(m.secondaryId(), sec, "secondary unchanged");
        yes(m.tab(id(2)) == t2 && m.tab(id(3)) == t3, "tab content objects untouched (no clone)"); eq(m.recentIds(), mru, "mru unchanged by reorder");
        yes(m.moveBefore(id(4), null), "move to end"); eq(m.tabIds(), Arrays.asList(id(1), id(2), id(3), id(4)), "moved to end");
        yes(m.moveBefore(id(3), id(2)), "move left by one"); eq(m.tabIds(), Arrays.asList(id(1), id(3), id(2), id(4)), "left by one");
        yes(m.moveBefore(id(1), id(4)), "move right"); eq(m.tabIds(), Arrays.asList(id(3), id(2), id(1), id(4)), "moved right before 4");
        List<String> order = m.tabIds(); rev = m.persistentRevision();
        yes(!m.moveBefore(id(2), id(2)), "same id"); yes(!m.moveBefore(id(9), id(2)), "missing id"); yes(!m.moveBefore(id(2), id(9)), "missing before");
        yes(!m.moveBefore("bad", null) && !m.moveBefore(null, null), "garbage ids");
        yes(!m.moveBefore(id(3), id(2)), "already directly before"); yes(!m.moveBefore(id(4), null), "already last");
        eq(m.tabIds(), order, "failed moves keep order"); eq(m.persistentRevision(), rev, "failed moves no revision");
        eq(m.activeId(), active, "still active"); invariants(m, "reorder");
        // keyboard cycling follows the NEW global order
        eq(m.adjacentId(id(3), 1), id(2), "next"); eq(m.adjacentId(id(3), -1), id(4), "prev wraps"); eq(m.adjacentId(id(4), 1), id(3), "next wraps");
        yes(m.adjacentId(id(3), 4) == null && m.adjacentId(id(3), 0) == null, "full-circle delta has no neighbour");
        yes(m.adjacentId("zzz", 1) == null, "unknown"); yes(new WorkspaceModel().adjacentId(id(1), 1) == null, "empty");
        WorkspaceModel one = new WorkspaceModel(); one.createTab(u(1)); yes(one.adjacentId(id(1), 1) == null, "single tab no neighbour");
    }

    static void closeFlow() {
        // reorder THEN close: closing must not disturb remaining order
        WorkspaceModel m = three(); m.createTab(u(4));
        m.moveBefore(id(4), id(1));                              // order 4,1,2,3 ; primary 4
        m.setSplit(true, id(4));                                 // secondary = most recent non-primary = 3
        eq(m.secondaryId(), id(3), "secondary 3");
        yes(m.removeConfirmed(id(4)), "close primary");          // hidden candidates by MRU: 2, then 1
        eq(m.tabIds(), Arrays.asList(id(1), id(2), id(3)), "order kept after close");
        eq(m.primaryId(), id(2), "primary refilled with most recent hidden"); eq(m.secondaryId(), id(3), "other pane unchanged");
        eq(m.activeId(), id(2), "refill becomes active (closed was active)"); invariants(m, "close primary");
        yes(m.removeConfirmed(id(1)), "close hidden"); eq(m.primaryId(), id(2), "hidden close no layout change"); eq(m.secondaryId(), id(3), "...");
        eq(m.activeId(), id(2), "active kept"); invariants(m, "close hidden");
        yes(m.removeConfirmed(id(3)), "close secondary, nothing hidden => collapse");
        yes(!m.isSplit() && m.secondaryId() == null, "collapsed"); eq(m.primaryId(), id(2), "remaining doc visible"); eq(m.activeId(), id(2), "active remaining");
        invariants(m, "collapse by close");
        yes(!m.removeConfirmed(id(3)) && !m.removeConfirmed("bad") && !m.removeConfirmed(null), "unknown close"); eq(m.size(), 1, "no change");
        yes(m.removeConfirmed(id(2)), "close last"); yes(m.isEmpty(), "empty"); invariants(m, "empty");
        yes(m.createTab(u(5)) && m.primaryId().equals(id(5)), "reusable after empty");
        // closing the NON-active visible pane keeps active
        m = three(); m.setSplit(true, id(3)); m.select(id(2), id(3));      // primary 3, secondary 2, active 2
        yes(m.removeConfirmed(id(3)), "close inactive visible");
        eq(m.activeId(), id(2), "active unchanged"); eq(m.primaryId(), id(1), "refilled from hidden"); eq(m.secondaryId(), id(2), "secondary unchanged");
        invariants(m, "close inactive visible");
        // closing a visible active secondary with a hidden doc waiting keeps split
        m = three(); m.setSplit(true, id(3)); m.select(id(2), id(3));
        yes(m.removeConfirmed(id(2)), "close active secondary"); yes(m.isSplit(), "split kept with hidden refill");
        eq(m.secondaryId(), id(1), "secondary refilled"); eq(m.activeId(), id(1), "active follows refill"); eq(m.primaryId(), id(3), "primary kept");
        invariants(m, "close active secondary");
    }

    static void metadataIndependence() {
        WorkspaceModel m = three(); m.setSplit(true, id(3));
        long rev = m.persistentRevision();
        yes(m.update(id(1), "하나.hwp", true, false, true), "update 1");
        yes(m.update(id(2), "둘", false, true, false), "update 2");
        WorkspaceModel.Tab t1 = m.tab(id(1)), t2 = m.tab(id(2)), t3 = m.tab(id(3));
        yes(t1.dirty && !t1.encrypted && t1.ready && t1.title.equals("하나.hwp"), "tab1 meta");
        yes(!t2.dirty && t2.encrypted && !t2.ready && t2.title.equals("둘"), "tab2 meta");
        yes(!t3.dirty && !t3.encrypted && !t3.ready && t3.title.isEmpty(), "tab3 untouched");
        eq(m.persistentRevision(), rev, "metadata never bumps persistent revision");
        yes(!m.update(id(1), "하나.hwp", true, false, true), "identical update is no-op");
        yes(!m.update(id(9), "x", true, true, true) && !m.update(null, "x", true, true, true), "unknown update");
        yes(m.update(id(1), "a\n\u0000b‮" + "x".repeat(300), false, false, false), "sanitised update");
        String s = m.tab(id(1)).title; yes(s.length() <= WorkspaceModel.MAX_TITLE, "title bounded");
        yes(s.startsWith("a  b") && s.indexOf('\n') < 0 && s.indexOf('\0') < 0 && s.indexOf('‮') < 0, "title control chars removed: " + s);
        yes(m.update(id(1), null, false, false, false) || m.tab(id(1)).title.isEmpty(), "null title -> empty");
        // metadata survives layout changes of other tabs and reorder
        m.update(id(2), "둘", true, true, true); m.moveBefore(id(3), id(1)); m.select(id(2), id(3)); m.removeConfirmed(id(1));
        yes(m.tab(id(2)).dirty && m.tab(id(2)).encrypted && m.tab(id(2)).title.equals("둘"), "dirty doc keeps meta through layout ops");
        // restore resets runtime metadata, keeps ids
        WorkspaceModel r = WorkspaceModel.restore(m.exportState());
        yes(!r.tab(id(2)).dirty && r.tab(id(2)).title.isEmpty(), "metadata is runtime-only");
        String json = m.snapshot().toJson(id(2));
        yes(json.contains("\"dirty\":true") && json.contains("\"title\":\"둘\""), "json has metadata");
        WorkspaceModel.State st = m.exportState();
        yes(!st.tabIds.toString().contains("둘") && !st.recentIds.toString().contains("둘"), "state has no titles");
    }

    static void cap() {
        WorkspaceModel m = new WorkspaceModel();
        for (int i = 1; i <= 5; i++) yes(m.createTab(u(i)), "create " + i);
        m.setSplit(true, id(5)); m.moveBefore(id(5), id(1)); m.update(id(3), "keep", true, false, true);
        String act = m.activeId(), pri = m.primaryId(), sec = m.secondaryId(); List<String> order = m.tabIds(), mru = m.recentIds();
        long rev = m.persistentRevision();
        yes(!m.canCreateTab(), "cannot create 6th"); yes(!m.createTab(u(6)), "6th refused"); yes(!m.createTab(u(6), id(1)), "6th refused with origin");
        eq(m.size(), 5, "size 5"); eq(m.tabIds(), order, "cap leaves order"); eq(m.activeId(), act, "cap leaves active");
        eq(m.primaryId(), pri, "cap leaves primary"); eq(m.secondaryId(), sec, "cap leaves secondary"); eq(m.recentIds(), mru, "cap leaves mru");
        yes(m.tab(id(3)).dirty && m.tab(id(3)).title.equals("keep"), "cap leaves metadata"); eq(m.persistentRevision(), rev, "cap no revision");
        invariants(m, "cap");
        m.removeConfirmed(id(2)); yes(m.canCreateTab() && m.createTab(u(6)), "slot reusable after close"); eq(m.size(), 5, "back at 5");
        WorkspaceModel one = new WorkspaceModel(); for (int i = 1; i <= 5; i++) one.createTab(u(i));
        // single-tab split cannot hit the cap; at cap with two tabs minimum there is always another tab
        yes(!one.isSplit() && one.setSplit(true, one.activeId()) == WorkspaceModel.SplitResult.CHANGED, "split at cap uses existing tab");
        // visibility never exceeds 2 across many operations
        for (int i = 0; i < 30; i++) { one.select(one.tabIds().get(i % 5), one.activeId()); invariants(one, "loop " + i); }
    }

    /** A workspace saved by an older build (limit 8) is restored whole: no tab is dropped, new tabs wait until enough are closed. */
    static void legacyWorkspaceRestore() {
        eq(WorkspaceModel.MAX_TABS, 5, "limit is five");
        List<String> ids = new ArrayList<>(); for (int i = 1; i <= 8; i++) ids.add(id(i));
        WorkspaceModel r = WorkspaceModel.restore(new WorkspaceModel.State(ids, id(2), id(2), id(7), true, Arrays.asList(id(2), id(7), id(8))));
        eq(r.size(), 8, "all eight tabs kept"); eq(r.tabIds(), ids, "order kept"); yes(r.isSplit() && r.isVisible(id(7)), "split kept");
        yes(r.isOverLimit(), "over the limit"); yes(!r.canCreateTab() && !r.createTab(u(9)) && !r.createTab(u(9), id(2)), "no new tab while over the limit");
        invariants(r, "legacy restore");
        for (int closed = 1; closed <= 4; closed++) {
            yes(r.removeConfirmed(id(2 + closed == 7 ? 8 : 2 + closed)), "close " + closed);
            invariants(r, "legacy close " + closed);
        }
        eq(r.size(), 4, "four left"); yes(!r.isOverLimit() && r.canCreateTab() && r.createTab(u(9)), "a slot opens below the limit"); eq(r.size(), 5, "five again");
        yes(!r.createTab(u(10)), "still capped at five");
        try { WorkspaceModel.restore(new WorkspaceModel.State(Arrays.asList(id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9)), id(1), id(1), null, false, null)); throw new AssertionError("nine tabs accepted"); }
        catch (IllegalArgumentException expected) { checks++; }
    }

    static void restoreValidation() {
        WorkspaceModel m = three(); m.setSplit(true, id(3)); m.select(id(2), id(3));
        WorkspaceModel.State s = m.exportState();
        WorkspaceModel r = WorkspaceModel.restore(s);
        eq(r.tabIds(), m.tabIds(), "ids"); eq(r.recentIds(), m.recentIds(), "mru"); eq(r.activeId(), m.activeId(), "active");
        yes(r.isSplit(), "split"); invariants(r, "restored");
        List<String> t = Arrays.asList(id(1), id(2), id(3));
        String[] reasons = {"empty", "dup", "9 tabs", "active unknown", "primary unknown", "secondary == primary", "split flag mismatch", "secondary missing", "active hidden",
                "bad uuid", "uppercase uuid", "recent dup", "recent unknown", "null active", "split w/o secondary"};
        List<WorkspaceModel.State> bad = new ArrayList<>();
        bad.add(new WorkspaceModel.State(new ArrayList<String>(), id(1), id(1), null, false, null));
        bad.add(new WorkspaceModel.State(Arrays.asList(id(1), id(1)), id(1), id(1), null, false, null));
        List<String> nine = new ArrayList<>(); for (int i = 1; i <= 9; i++) nine.add(id(i));
        bad.add(new WorkspaceModel.State(nine, id(1), id(1), null, false, null));
        bad.add(new WorkspaceModel.State(t, id(9), id(1), null, false, null));
        bad.add(new WorkspaceModel.State(t, id(1), id(9), null, false, null));
        bad.add(new WorkspaceModel.State(t, id(1), id(1), id(1), true, null));
        bad.add(new WorkspaceModel.State(t, id(1), id(1), id(2), false, null));
        bad.add(new WorkspaceModel.State(t, id(1), id(1), id(9), true, null));
        bad.add(new WorkspaceModel.State(t, id(3), id(1), id(2), true, null));
        bad.add(new WorkspaceModel.State(Arrays.asList("not-a-uuid", id(2)), id(2), id(2), null, false, null));
        bad.add(new WorkspaceModel.State(Arrays.asList(id(1).toUpperCase(), id(2)), id(2), id(2), null, false, null));
        bad.add(new WorkspaceModel.State(t, id(1), id(1), null, false, Arrays.asList(id(1), id(1))));
        bad.add(new WorkspaceModel.State(t, id(1), id(1), null, false, Arrays.asList(id(9))));
        bad.add(new WorkspaceModel.State(t, null, id(1), null, false, null));
        bad.add(new WorkspaceModel.State(t, id(1), id(1), null, true, null));
        for (int i = 0; i < bad.size(); i++) {
            try { WorkspaceModel.restore(bad.get(i)); throw new AssertionError("accepted invalid state: " + reasons[i]); }
            catch (IllegalArgumentException expected) { checks++; }
        }
        try { WorkspaceModel.restore(null); throw new AssertionError("null accepted"); } catch (IllegalArgumentException expected) { checks++; }
        // restore without recent list rebuilds a complete mru, active first
        WorkspaceModel p = WorkspaceModel.restore(new WorkspaceModel.State(t, id(2), id(1), id(2), true, null));
        eq(p.recentIds().get(0), id(2), "mru head active"); eq(p.recentIds().get(1), id(1), "mru second other pane"); eq(p.recentIds().size(), 3, "mru complete");
        invariants(p, "restored w/o recent");
    }

    @SuppressWarnings({"unchecked", "rawtypes"}) static void uncheckedClear(List<?> l) { ((List) l).clear(); }
    @SuppressWarnings({"unchecked", "rawtypes"}) static void uncheckedPut(Map<?, ?> m) { ((Map) m).put("dirty", Boolean.FALSE); }

    static void snapshots() {
        WorkspaceModel m = three(); m.setSplit(true, id(3)); m.update(id(1), "x", true, false, true);
        WorkspaceModel.Snapshot snap = m.snapshot();
        List<String> order = m.tabIds(), mru = m.recentIds(); String act = m.activeId(), pri = m.primaryId(), sec = m.secondaryId();
        Map<String, Object> map = snap.toMap(id(3));
        eq(map.get("enabled"), Boolean.TRUE, "enabled"); eq(map.get("selfId"), id(3), "selfId"); eq(map.get("maxTabs"), 5, "maxTabs");
        eq(map.get("activeId"), act, "map active"); eq(map.get("primaryId"), pri, "map primary"); eq(map.get("secondaryId"), sec, "map secondary"); eq(map.get("split"), Boolean.TRUE, "map split");
        List<?> tabs = (List<?>) map.get("tabs"); eq(tabs.size(), 3, "map tabs");
        Map<?, ?> first = (Map<?, ?>) tabs.get(0);
        eq(first.get("id"), id(1), "tab id"); eq(first.get("title"), "x", "tab title"); eq(first.get("dirty"), Boolean.TRUE, "tab dirty");
        eq(first.get("encrypted"), Boolean.FALSE, "tab enc"); eq(first.get("ready"), Boolean.TRUE, "tab ready");
        // mutating snapshots/exported lists must be impossible or harmless
        try { snap.tabs().clear(); throw new AssertionError("tabs mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { map.put("activeId", "x"); throw new AssertionError("map mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { uncheckedClear(tabs); throw new AssertionError("tabs list mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { uncheckedPut(first); throw new AssertionError("tab map mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { m.tabIds().clear(); throw new AssertionError("tabIds mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { m.visibleIds().clear(); throw new AssertionError("visible mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { m.recentIds().clear(); throw new AssertionError("recent mutable"); } catch (UnsupportedOperationException e) { checks++; }
        try { m.exportState().tabIds.clear(); throw new AssertionError("state mutable"); } catch (UnsupportedOperationException e) { checks++; }
        eq(m.tabIds(), order, "model unchanged"); eq(m.recentIds(), mru, "mru unchanged"); eq(m.activeId(), act, "active unchanged");
        eq(m.primaryId(), pri, "primary unchanged"); eq(m.secondaryId(), sec, "secondary unchanged"); yes(m.tab(id(1)).dirty, "meta unchanged");
        // a snapshot is a point in time copy
        m.removeConfirmed(id(1)); eq(snap.tabs().size(), 3, "snapshot independent of later changes");
        eq(new WorkspaceModel().snapshot().toMap(id(1)).get("secondaryId"), null, "empty snapshot null ids");
        // JSON
        WorkspaceModel j = new WorkspaceModel(); j.createTab(u(1)); j.update(id(1), "q\"\\ /\u0001", false, true, false);
        String json = j.snapshot().toJson(id(1));
        yes(json.startsWith("{\"enabled\":true,\"selfId\":\"" + id(1) + "\",\"tabs\":[{\"id\":\"" + id(1) + "\""), "json prefix " + json);
        yes(json.contains("\"secondaryId\":null") && json.contains("\"split\":false") && json.endsWith("\"maxTabs\":5}"), "json suffix " + json);
        yes(json.indexOf(' ') < 0 && json.indexOf('\u0001') < 0, "json has no raw separators/controls");
        yes(json.contains("\\\"") && json.contains("\\\\"), "json escapes quotes/backslashes");
    }

    static void sequence() {
        // the end-to-end user story: 3 docs, split, swap, reorder, close one, nobody lost
        WorkspaceModel m = three();                                   // 1,2,3 ; primary 3
        m.update(id(1), "A", true, false, true); m.update(id(2), "B", false, false, true); m.update(id(3), "C", true, false, true);
        m.setSplit(true, id(3));                                      // 3 | 2
        m.select(id(1), id(2));                                       // 3 | 1 (2 hidden)
        eq(m.primaryId() + m.secondaryId(), id(3) + id(1), "3|1");
        m.moveBefore(id(1), id(3)); m.moveBefore(id(2), id(1));       // order 2,1,3
        eq(m.tabIds(), Arrays.asList(id(2), id(1), id(3)), "reordered");
        eq(m.primaryId() + m.secondaryId(), id(3) + id(1), "panes unchanged by reorder");
        eq(m.select(m.adjacentId(m.activeId(), 1), m.activeId()), true, "ctrl+tab");   // active 1 -> next is 3 (visible primary)
        eq(m.activeId(), id(3), "ctrl+tab focuses visible neighbour");
        eq(m.primaryId() + m.secondaryId(), id(3) + id(1), "ctrl+tab no duplicate placement");
        m.select(m.adjacentId(m.activeId(), 1), m.activeId());        // 3 -> wraps to 2 (hidden) replaces origin pane (primary)
        eq(m.primaryId() + m.secondaryId(), id(2) + id(1), "wrap selects hidden into origin pane");
        m.removeConfirmed(id(1));                                     // secondary closed; hidden 3 refills
        eq(m.tabIds(), Arrays.asList(id(2), id(3)), "remaining");
        eq(m.primaryId() + m.secondaryId(), id(2) + id(3), "hidden doc refills pane, split kept");
        yes(m.tab(id(3)).dirty && m.tab(id(3)).title.equals("C") && m.tab(id(2)).title.equals("B"), "survivors keep metadata");
        m.setSplit(false, m.activeId()); eq(m.size(), 2, "collapse loses nothing"); invariants(m, "end");
    }

    public static void main(String[] args) {
        createAndSelect(); splitSwapFocusCollapse(); splitNeedsNewTab(); reorder(); closeFlow(); metadataIndependence(); cap(); legacyWorkspaceRestore(); restoreValidation(); snapshots(); sequence();
        System.out.println("WorkspaceModelTest OK (" + checks + " checks)");
    }
}
