# Userbox

A userbox for editors who use (or want to advertise) the AI Source Verification
user script. Paste it on your user page as-is, or save it as a template such as
`User:<You>/Userboxes/AI Source Verification` and transclude it with
`{{User:<You>/Userboxes/AI Source Verification}}`.

## Ready to paste (no template needed)

This uses only core wikitext, so it works on any user page without relying on
`{{Userbox}}` existing on the wiki.

```wikitext
{| style="border:1px solid #a2a9b1; background:#f8f9fa; color:#202122; width:238px; margin:1px; float:left; font-size:8pt;"
|-
| style="background:#fff; text-align:center; width:45px; height:45px; padding:0 2px;" | [[File:Sv logo.svg|40px|link=User:Alaexis/AI_Source_Verification|alt=AI Source Verification]]
| style="padding:2px 6px; vertical-align:middle; line-height:1.3;" | This user checks citations with [[User:Alaexis/AI_Source_Verification|AI Source Verification]].
|}
```

## Using `{{Userbox}}` (English Wikipedia)

```wikitext
{{Userbox
| border-c = #a2a9b1
| id-c     = #fff
| info-c   = #f8f9fa
| id       = [[File:Sv logo.svg|40px|link=User:Alaexis/AI_Source_Verification|alt=AI Source Verification]]
| info     = This user checks citations with [[User:Alaexis/AI_Source_Verification|AI Source Verification]].
}}
```

## Variants

Swap the `info` text for another line if you prefer:

- `This user verifies sources with [[User:Alaexis/AI_Source_Verification|AI Source Verification]].`
- `This user supports [[User:Alaexis/AI_Source_Verification|AI Source Verification]], a citation-checking tool.`

To list your page in a category, add `[[Category:Wikipedians who use AI Source Verification]]`
to the template. That category is a suggestion and does not exist yet; create
it, or drop the line.

## Installing the script

```js
importScript('User:Alaexis/AI_Source_Verification.js');
```

Add that line to your [`common.js`](https://en.wikipedia.org/wiki/Special:MyPage/common.js).
