# Approval (@fleet-console/approval)

Console-wide approval records. Leaf foundation package: Node built-ins only. It does not import features, core, or the CLI.

Types are registered by the host through the deps object this package returns. It has no service locator. Description proposals and any later immediate type live in the feature that owns them; this package only stores the record, the status transition, and the snapshot.
