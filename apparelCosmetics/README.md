# Apparel Cosmetics

This is an independent server-only entitlement mod for category-30 apparel.
It does not modify or depend on `cosmeticStoreSeeder`, although it is designed
to consume apparel items delivered by that store seeder.

Players activate a purchased apparel item with:

```text
/apparel list
/apparel activate <inventoryItemID>
```

Activation consumes one item and permanently unlocks its type for the character.
Paper-doll updates containing locked configured apparel are rejected by the
server. The client may still display the items in its picker because this
version does not change client files.

## Legacy characters

The first time an existing character's appearance is validated, the mod reads
the character's saved appearance and permanently unlocks any configured
apparel types already being worn. This migration runs once per character and
does not require an inventory item, so legacy players keep their current
apparel while newly selected apparel still requires activation.

The mod also repairs the client-facing inventory state: when a saved unlocked
apparel type is missing from the character's current station hangar, one
matching physical item is created there. This occurs when paper-doll data is
read and before an unlocked apparel type is saved, preventing the client from
reporting that the worn item is missing.
