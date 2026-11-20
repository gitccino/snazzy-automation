# Publication verification repair

For a captured pre-document failure, verification can set a matching Generating record to Failed after rechecking the claim, failure evidence and Airtable record. It rereads the record even when the update response is lost and only confirms failure when the reread and D1 evidence agree. Observed conflicting status or document fields are held for review.

Airtable does not offer a conditional status update here. A manual edit between the final read and PATCH can be overwritten, and a concurrent edit after the confirmation read cannot be detected atomically with the D1 result. Operators must account for this residual cross-system race; the checks do not guarantee preservation of every concurrent manual edit.
