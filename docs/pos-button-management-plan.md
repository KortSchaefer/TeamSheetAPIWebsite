# POS Button Management implementation plan

## Existing architecture

- `menu_categories` and `menu_items` are the existing product catalog. The POS terminal bootstrap currently seeds/returns categories, but `public/pos.html` intentionally disables item ordering.
- `pos_tables`, `pos_orders`, and `pos_order_items` already own table/check lifecycle. New ordering behavior will extend these records instead of replacing them.
- Manager/admin web authentication is the established authorization boundary for configuration pages. Employee-number POS sessions remain the order-entry boundary.
- FastAPI is the reference POS implementation. The Cloudflare Worker serves static assets but does not yet own `/pos/*`; D1 receives a matching immutable migration so a later bounded route migration can preserve this contract.

## Incremental implementation

1. Extend the catalog with normalized POS pages, buttons, tags, modifier groups/options, assignments, behavior rules, ingredient roles, and audit records. Keep visual, availability, routing, metadata, conditions, actions, and assignment overrides as scoped JSON fields.
2. Add manager/admin CRUD, duplicate/disable/restore, layout, audit, and validated import/export APIs. Expose named POS permissions from the existing role model rather than creating a competing authentication system.
3. Resolve tag-inherited modifier groups and rules during terminal bootstrap. Direct button assignments and button-level overrides win over inherited tag behavior.
4. Add terminal item entry using configured buttons and validated modifier selections, updating check totals and preserving a configuration snapshot on each order line.
5. Add a visual admin editor with search/filtering, live appearance preview, reusable tag/modifier management, JSON advanced settings, and drag/drop grid persistence.
6. Update the existing POS page to render configured pages/buttons while keeping empty-check and legacy catalog behavior as a fallback.

## Migration strategy

- Existing `menu_items` remain valid products. An idempotent bootstrap creates a default page/button for active legacy items that do not yet have a POS button.
- Existing menu categories remain API-compatible and are mapped to POS pages by stable slug/name.
- Soft-deleted buttons retain their product, assignments, layout, and audit history and can be restored.
- The Alembic and D1 migrations are additive. No existing POS table, order, or catalog row is dropped or rewritten.

## Performance and rollback

- Terminal bootstrap preloads a resolved page/button graph with eager relationships; button presses use primary-key lookups and do not recompute the full graph.
- Indexed page, product, tag, assignment, active, and audit columns support the editor and runtime query paths.
- Rollback is application-level first: stop exposing configured buttons and retain the existing category/empty-check fallback. Schema rollback only drops newly added configuration tables/columns and is not required for operational rollback.
