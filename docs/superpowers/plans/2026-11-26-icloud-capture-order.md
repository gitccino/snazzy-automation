# iCloud capture order implementation

Design: [Order iCloud imports by capture time](../specs/2026-11-26-icloud-capture-order-design.md).

1. In the iCloud reader tests, reproduce the staging shape with two shuffled legacy snapshots. Include a normal marker and an ignore marker. Check that the same IDs get the same positions regardless of response order. Cover offsets, missing/invalid values, and tied timestamps. Preserve the existing CloudKit ordering tests.
2. In the legacy reader, validate capture times and order the snapshot before assigning positions. Reuse comparison logic if both readers need it. Retain exact source IDs, asset links, and stored capture values. Keep the change isolated to the provider and narrow group compatibility behavior.
3. In repository and import tests, seed a successful historical group and replay it with the same member set in a different order, then append a normal group and an ignored block. Confirm the previous success is skipped before upserting new rows. Keep the existing hold for true membership changes and incomplete history. Check verification replay if it relies on the same group identity.
4. Run the focused suites, typecheck, and full check. Compare any failures against main. Commit the fix on `fix/legacy-icloud-capture-order`. Merge the verified patch into main and then rebase the feature branch locally. Rerun the affected checks on the rebased feature.
