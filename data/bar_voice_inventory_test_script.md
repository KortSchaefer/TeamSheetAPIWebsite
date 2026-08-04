# Bar Voice Inventory Read-Aloud Test

Use this script to create a realistic sample count for the `Bar` location.
The quantities are fictional, intentionally varied, and meant for testing—not
for ordering or setting pars.

## Before reading

1. Import the bar inventory if it is not already loaded:

   ```powershell
   .\venv\Scripts\python.exe scripts\import_bar_inventory.py
   ```

2. Open the voice inventory page and select the `Bar` location.
3. Start listening, then read one numbered block at a time.
4. Do not read the headings, numbers, quotation marks, or notes in parentheses.
5. Pause briefly after each block. Within a block, say `next`, `bump`, or
   `then` exactly as written.
6. These are count units. Bottled beer is counted as individual bottles, canned
   seltzer as individual cans, and draft beer as partial or whole kegs.

## Pass 1 — Syrups and mixes

1. “Monin mango syrup, two bottles. Next Monin watermelon syrup, one and a half bottles. Next Monin strawberry syrup, two bottles. Next Monin blue curaçao syrup, one bottle.”

2. “Monin raspberry syrup, one and a half bottles. Bump Monin peach syrup, two bottles. Bump Monin coconut syrup, one bottle. Bump Monin vanilla syrup, two and a quarter bottles.”

3. “Strawberry purée, two containers. Next sangria mix, one and a half containers. Next piña colada mix, two containers. Next old fashioned mix, one container.”

## Pass 2 — Wine

4. “Barefoot Moscato bottle, six bottles. Next Ecco Domani Pinot Grigio bottle, five bottles. Next Nobilo Sauvignon Blanc bottle, four bottles.”

5. “Canyon Road Chardonnay bottle, six bottles. Bump Kendall Jackson Chardonnay bottle, four bottles. Bump La Marca Prosecco one eighty-seven milliliter bottle, eight bottles.”

6. “Canyon Road Merlot bottle, five bottles. Next Meiomi Pinot Noir bottle, four bottles. Next Josh Cellars Cabernet bottle, six bottles. Next Barefoot Merlot bottle, five bottles.”

7. “Dark Horse wine bottle, four bottles.”

   Expected behavior: this item should remain easy to find, but its varietal is
   flagged for manager confirmation.

## Pass 3 — Vodka and tequila

8. “Absolut Citron vodka, two bottles. Next Tito's vodka, three and a half bottles. Next Deep Eddy's Lemonade, two bottles. Next Wheatley vodka, two bottles.”

9. “Grey Goose vodka, three bottles. Bump Pinnacle vodka, one and a half bottles. Bump well vodka, four bottles.”

10. “Eighteen hundred Reposado tequila, two bottles. Next Patron Silver tequila, three bottles. Next Patron Repo, two and a half bottles.”

11. “Patron Añejo tequila, one bottle. Bump well tequila, four bottles. Bump Don Julio tequila, two bottles.”

12. “Grand Marnier, two bottles.”

   Expected behavior: Grand Marnier should resolve to orange liqueur, not
   tequila.

## Pass 4 — Scotch, Irish whiskey, rum, and gin

13. “The Glenlivet Scotch, one and a half bottles. Next Jameson Irish whiskey, three bottles.”

14. “Bacardi rum, three bottles. Next Captain Morgan rum, three bottles. Next Cruzan strawberry rum, one and a half bottles.”

15. “Malibu rum, three bottles. Bump Parrot Bay coconut rum, two bottles. Bump well rum, four bottles.”

16. “Tanqueray gin, two bottles. Next Bombay Sapphire gin, two bottles. Next well gin, three bottles.”

## Pass 5 — Liqueurs and cognac

17. “Razzmatazz raspberry liqueur, one bottle. Next peach liqueur, two bottles. Next butterscotch schnapps, one bottle.”

18. “Blue curaçao liqueur, two bottles. Bump Baileys Irish Cream, two bottles. Bump Kahlúa coffee liqueur, two bottles.”

19. “Watermelon liqueur, one and a half bottles. Next well amaretto, two bottles. Next apple liqueur, one bottle. Next Courvoisier cognac, one and a half bottles.”

## Pass 6 — Bourbon and whiskey

20. “Canada Club, two bottles. Next Crown Royal whisky, three bottles. Next Fireball whisky, three bottles.”

21. “Jack Daniel's whiskey, four bottles. Bump Jim Beam bourbon, three bottles. Bump Maker's Mark, three bottles.”

22. “Crown Apple whisky, two bottles. Next Seagram's Seven whiskey, two bottles. Next Southern Comfort, two bottles.”

23. “Woodford Reserve bourbon, two bottles. Bump Buffalo Trace bourbon, two bottles. Bump Old Smoky Watermelon, one bottle.”

## Pass 7 — Draft beer

24. “Bud Light draft, one and a half kegs. Next Budweiser draft, half a keg. Next Miller Lite draft, one keg.”

25. “Modelo draft, one keg. Bump Stella Artois draft, half a keg. Bump Pacifico draft, half and a quarter kegs.”

26. “Michelob Ultra draft, one and a quarter kegs. Next Rhinegeist Truth draft, half a keg. Next Big Wave draft, half a keg.”

27. “Oktoberfest draft, quarter keg. Bump Blue Moon draft, half and a quarter kegs. Bump Mango Cart draft, half a keg. Bump Bush Light draft, one keg.”

   Expected behavior: Modelo and Oktoberfest should be countable but remain
   flagged for their missing variety or brewery details.

## Pass 8 — Bottled beer, cider, and seltzer

28. “Budweiser beer bottles, eighteen bottles. Next Bud Light beer bottles, twenty-four bottles. Next Coors Light beer bottles, eighteen bottles.”

29. “Shiner Bock bottles, twelve bottles. Bump Coors Banquet bottles, twelve bottles. Bump Corona Extra bottles, twenty-four bottles.”

30. “Dos Equis bottles, eighteen bottles. Next Dos Equis Zero bottles, six bottles. Next Guinness packaged beer, six. Next Heineken bottles, eighteen bottles. Next Heineken Zero bottles, six bottles.”

31. “Michelob Ultra beer bottles, twenty-four bottles. Bump Miller Lite beer bottles, twenty-four bottles. Bump Angry Orchard bottles, twelve bottles.”

32. “Truly Wild Berry, twelve cans. Next Sam Adams Winter Lager, twelve bottles. Next Truly Strawberry, twelve cans.”

33. “Yuengling lager bottles, eighteen bottles. Bump Blue Moon bottles, twelve bottles. Bump Voodoo Ranger, twelve.”

   Voodoo Ranger deliberately omits the unit because the store still needs to
   confirm whether this product is stocked as bottles or cans.

## Pass 9 — Fountain and nonalcoholic supplies

34. “Coke, two bags in box. Next Diet Coke, one and a half bags in box. Next Sprite, two bags in box.”

35. “Doctor Pepper, one bag in box. Bump lemonade concentrate, one and a half bags in box. Bump Mellow Yellow, one bag in box.”

36. “Coke Zero, one and a half bags in box. Next tonic water supply, twelve containers. Next root beer fountain syrup, one bag in box.”

37. “Sweet tea supply, four packages. Bump unsweet tea supply, four packages. Bump regular coffee supply, six packages. Bump decaf coffee supply, three packages.”

## Optional correction and duplicate tests

Read these only after the main pass. They intentionally update existing counts.

38. “Change Tito's vodka, four bottles.”

   Expected result: Tito's should change from three and a half to four bottles.

39. “Add Bud Light beer bottles, six bottles.”

   Expected result: Bud Light bottles should increase from twenty-four to
   thirty.

40. “Change Bud Light draft, one and a quarter kegs.”

   Expected result: Bud Light draft should change from one and a half to one
   and a quarter kegs without affecting Bud Light bottles.

41. “Remove Dark Horse wine bottle.”

   Expected result: the Dark Horse count should be removed from the effective
   count while retaining the audit trail.

## What this test covers

- Short and long continuous utterances.
- `next`, `bump`, and `then` transition handling.
- Whole-number and fractional bottle, container, and keg counts.
- Similar draft-versus-bottle product names.
- Spoken aliases and corrected brand names.
- Products that require store confirmation.
- `change`, `add`, and `remove` actions.
- 116 of the 117 physical bar inventory records across every major bar
  category. The unresolved Michelob Amber tap is intentionally omitted.
