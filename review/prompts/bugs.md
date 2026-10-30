# bugs

Trace changed behavior through its callers and data flow. Look for incorrect results, state/lifecycle bugs, concurrency hazards, error-path regressions, and public API or configuration compatibility breaks.

Inspect the tests around changed behavior: flag a concrete untested failure mode when it exposes a plausible defect or violates an explicit testing requirement, not an arbitrary coverage target. Provide the input, sequence, or condition that triggers each bug. Security-only concerns belong to the security lens; stylistic architecture preferences do not belong here.
