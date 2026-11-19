package kr.offline.hwp;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Intersect Android's zero-based inclusive ranges with the document, in output order. */
final class PrintPageRanges {
    static List<int[]> normalize(int[][] requested, int count) {
        List<int[]> ranges = new ArrayList<>();
        for (int[] range : requested) {
            int first = Math.max(0, range[0]);
            int last = Math.min(count - 1, range[1]);
            if (first <= last) ranges.add(new int[]{first, last});
        }
        ranges.sort(Comparator.comparingInt(range -> range[0]));
        List<int[]> merged = new ArrayList<>();
        for (int[] range : ranges) {
            int[] previous = merged.isEmpty() ? null : merged.get(merged.size() - 1);
            if (previous != null && range[0] <= previous[1] + 1) {
                previous[1] = Math.max(previous[1], range[1]);
            } else {
                merged.add(range);
            }
        }
        return merged;
    }
}
