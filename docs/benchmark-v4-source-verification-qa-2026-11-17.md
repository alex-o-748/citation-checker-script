# Benchmark v4: rows from the Source Verification QA sheet (2026-11-17)

`v4` is 74 rows (`row_191`–`row_264`) imported from the WMF **Source Verification QA** Google Sheet. In that sheet, volunteer reviewers checked flags raised by the batch pipeline (`service/run-sweep.js`) against the cited sources. 68 of the 74 rows are scoreable:

| Label | Rows | Scoreable |
|---|---|---|
| Not supported | 40 | 39 |
| Partially supported | 19 | 18 |
| Supported | 15 | 11 |
| **Total** | **74** | **68** |

Every row came from a model flag. The 15 Supported rows are flags a reviewer rejected, so **v4 is false-positive and true-positive evidence for the flagging path**. It was not sampled the way v1–v3 were, and its label mix says nothing about how often citations fail in the wild.

## What the reviewers answered

The sheet asked one question per flag: *"Is the model verdict correct that the claim is not supported?"* Reviewers opened the article's sources and answered *Yes*, *No (claim and source clearly agree)* or *Unsure*. They also noted whether the extracted claim was complete and whether the URLs were right. 138 rows were annotated across nine sample tabs (evergreen, BLP, history, contentious topics, dubious, failed-verification, AI-generated, GA candidates, NPP).

## Import rules

A row was imported only if all of these hold:

1. The reviewer answered *Yes* or *No*. The 26 *Unsure* rows were left out.
2. The flag was on **one** source. Benchmark rows are single-source, so the 13 group verdicts over 2–3 sources were left out.
3. The reviewer did not mark the claim incomplete (7 rows). Bare list items and fragments were also left out ("Battle royale", "Szindbád (1971)", "His younger twin sisters Breanna"), since their label depends on article context the model never sees.
4. The label is about *this* source as fetched. Rows judged against another citation, paywalled for the reviewer, or dependent on which version of the source was read were left out.

Labels, under the rubric in `core/prompts.js` (contradiction → Not supported; part supported and the rest merely absent → Partially supported):

- **Reviewer says the model was wrong** → `Supported`.
- **Reviewer says the model was right** → the model's verdict, except where the rubric clearly disagrees. Reviewers answered "is it unsupported?", not "Partially or Not?", so the split between those two is ours. Eleven rows were changed:
  - Ten went from Not supported to **Partially supported**: the model's rationale (which the reviewer endorsed) says the source confirms a distinct part of the claim and is merely silent on the rest.
  - One went from Partially supported to **Not supported**: `row_260`, where the source gives 1995 and the claim says 1996.
  - Every override is marked `NS->PS` / `PS->NS` in the table below. Rows kept as Not supported despite partial confirmation are marked `kept NS`, with the reason (the unconfirmed part is the claim's principal assertion). **These are the labels to revisit if the rubric boundary is ever settled differently.**

Four Supported rows (`row_218`, `row_219`, `row_240`, `row_262`) have a **pronoun subject** ("He", "She", "her", "It"). The prompt carries only the claim and the source, so the model cannot know who the subject is. They are kept on purpose: they measure the pronoun false positive reviewers reported, and they are the rows that move if article context is ever added to the prompt.

## Source fetching

Rows carry the reviewed claim text and source URL in the `WMF claim text` / `WMF source URL` override columns, so `extract_dataset.js` skips the article fetch and fetches the source fresh through the CORS proxy.

- **Wayback substitutes.** Seven publishers (BBC ×2, Britannica, Politico, IAS, TouchArcade, Stylo24) return 403 to the proxy. Their `WMF source URL` is the nearest Wayback snapshot, which is the same fallback the userscript takes. Their provenance ends `live_url_403_via_proxy`.
- **Excluded (`Exclude reason` column).** Six rows whose stored source cannot support any label: a PDF and a WorldCat record that never fetch, a WSJ paywall stub, a Wayback redirect banner, a Britannica page whose History section did not come through, and `row_210`. The cited Newsweek snapshot in `row_210` says "more than 70,000 signatures", which contradicts the claim's 160,000; the reviewer evidently read a later version.
- **Evidence checked.** For every Supported row, the stored text was searched for the evidence the reviewer pointed to. The rows above are the ones where it was missing. No v4 source hit a fetch cap (`source_truncated` is false throughout).

## Traceability

`provenance` reads `human-annotation:source-verification-qa-2026-11 <tab>#<sheet row> <cite_ref id> check_id=<id>`. The `check_id` joins to `verification_logs` in Neon, which holds the original verdict and rationale. Reviewer names are not copied into the repo.

`Citation number` / `Citation instance` are **approximate** for most rows. Wikipedia rate-limited the import, so only 9 were read from the rendered page; the rest come from the `cite_ref` id (`cite_ref-name_N-K` → number N, instance K+1). That rule matched the rendered `[N]` for 86% of citations on the pages that did load. Nothing uses these numbers to locate a reference, because every v4 row has full overrides. Use the `cite_ref` id in provenance when you need the exact citation.

## Not done yet

- **No benchmark run.** `npm run benchmark:v4` then `npm run analyze:v4`. Because every row was flagged by one model (the batch default at the time), compare other providers on v4 with that selection bias in mind.
- The 26 *Unsure* rows and 13 group verdicts are candidates for a second review pass. Group verdicts would need multi-source rows in the benchmark first.

## Per-row decisions

Generated from the sheet export. "Model said" is the batch pipeline's verdict; "Reviewer" is whether the reviewer judged it correct.

### Imported rows

| Row | Sheet | Model said | Reviewer | Label | Claim | Note |
|---|---|---|---|---|---|---|
| `row_191` | evergreen #67 | Not Supported | correct | Not supported | His public alignment with Inter and subsequent comments have drawn criticism regarding hi… | kept NS: source confirms the Inter fandom, but the principal assertion (criticism over neutrality) is absent |
| `row_192` | evergreen #68 | Not Supported | correct | Not supported | A group of possible housemates will enter at the same time and the live audience will vot… |  |
| `row_193` | evergreen #72 | Not Supported | correct | Not supported | Art had become a coping mechanism for Kusama. |  |
| `row_194` | evergreen #73 | Not Supported | correct | Not supported | Steinem eventually landed a job at Felker's newly founded New York magazine in 1968. |  |
| `row_195` | evergreen #76 | Not Supported | correct | Partially supported | Professor Oldman in the parody film Scary Movie 2 (2001), | NS->PS: source lists Scary Movie 2 in the filmography but not the character |
| `row_196` | evergreen #77 | Not Supported | correct | Not supported | The feature used to be active only during December. |  |
| `row_197` | evergreen #78 | Not Supported | correct | Not supported | Though Alamgir was unhurt, three vehicles (including the one in which he was riding) were… | contradiction |
| `row_198` | evergreen #80 | Not Supported | correct | Not supported | Musashi – High School Fleet |  |
| `row_199` | evergreen #81 | Not Supported | correct | Not supported | Chimes at Midnight (1965) |  |
| `row_200` | evergreen #82 | Partially Supported | correct | Partially supported | Harald died at 06:35 (UTC+2) on 28 August, aged 89. |  |
| `row_201` | evergreen #83 | Partially Supported | correct | Partially supported | Bud Cort, American actor and comedian (voice of Toyman in the DC Animated Universe, Tempe… |  |
| `row_202` | evergreen #89 | Not Supported | correct | Not supported | SBS confirmed its participation, while China, Japan and South Korea were named as potenti… | contradiction |
| `row_203` | evergreen #195 | Not Supported | correct | Not supported | August 15 – At least 129 people are killed and nearly 1,300 injured when a magnitude 7.7 … | contradiction |
| `row_204` | evergreen #233 | Partially Supported | correct | Partially supported | At the ceremony itself, Parton was honored with the Willie Nelson Lifetime Achievement Aw… |  |
| `row_205` | evergreen #242 | Not Supported | correct | Partially supported | At the Wimbledon Championships, Gauff defeated wildcard entrant Francesca Jones, Elena Ve… | NS->PS: source confirms Vesnina, omits Francesca Jones |
| `row_206` | evergreen #400 | Not Supported | wrong | Supported | After her breakout run at 2019 Wimbledon, New Balance launched a "Call Me Coco" campaign … |  |
| `row_207` | evergreen #432 | Not Supported | wrong | Supported | 1765: Tokelau — John Byron reached the islands. | **excluded:** fetched page lacks the History section the label rests on |
| `row_208` | evergreen #481 | Not Supported | wrong | Supported | Scott, a former United States Border Patrol Chief at the time, claimed would be "downgrad… |  |
| `row_209` | evergreen #590 | Not Supported | correct | Not supported | AdventHealth opened a 200,000 square feet (19,000 m2) emergency room and primary care fac… | contradiction |
| `row_210` | evergreen #595 | Not Supported | wrong | Supported | A petition to posthumously rename Nashville International Airport in her honor surpassed … | **excluded:** cited snapshot says 70 |
| `row_211` | evergreen #832 | Not Supported | correct | Not supported | to reach the quarterfinals, where she lost to Victoria Azarenka in three sets. | contradiction |
| `row_212` | evergreen #1406 | Partially Supported | correct | Partially supported | In May, her induction was announced and on November 5, 2022, she was inducted into the Ro… |  |
| `row_213` | evergreen #1786 | Not Supported | correct | Not supported | In 2018, after turning pro at the age of 14, Gauff signed with Team8, a sports management… | contradiction |
| `row_214` | evergreen #1852 | Not Supported | correct | Not supported | On 17 June 2026, Keir Starmer announced that the Children's Wellbeing and Schools Act 202… | contradiction |
| `row_215` | evergreen #2079 | Not Supported | correct | Not supported | September 9 – A fire on the ferry MV June Aster kills at least 76 people and 13 others go… | contradiction |
| `row_216` | blp #21 | Partially Supported | correct | Partially supported | On June 9, 2010, Tate was drafted by the San Francisco Giants in the 50th round (1,518th … |  |
| `row_217` | blp #22 | Not Supported | correct | Partially supported | On April 17, 2026, Dunn signed a two-year deal with the Sydney Flames of the Women's Nati… | NS->PS: source confirms the two-year Sydney Flames deal, omits the date |
| `row_218` | blp #124 | Not Supported | wrong | Supported | He is a supporter of homeopathy, having signed an early day motion in support of its cont… | pronoun subject ("He"): supported once the subject is known |
| `row_219` | blp #136 | Not Supported | wrong | Supported | She retired after the 2006 World Cup. | pronoun subject ("She"): supported once the subject is known |
| `row_220` | blp #151 | Not Supported | correct | Not supported | It was later revealed that this was due to a clash with her label, 4AD. |  |
| `row_221` | history #11 | Not Supported | correct | Not supported | She is buried beside her husband in the nave of St George's Chapel, Windsor Castle. |  |
| `row_222` | history #12 | Not Supported | correct | Not supported | It is today the oldest in continuous existence. |  |
| `row_223` | history #13 | Partially Supported | correct | Partially supported | A statue of Earhart by Ernest Shelton was erected circa 1971 in Los Angeles, California. |  |
| `row_224` | history #14 | Not Supported | correct | Partially supported | Margaret wrote letters to her father declaring her homesickness, but Henry could do nothi… | NS->PS: source confirms the homesick letters, omits the rest |
| `row_225` | history #16 | Not Supported | correct | Not supported | The museum's director, Hartwig Fischer, resigned because of the museum's inadequate respo… | kept NS: resignation confirmed, but the stated cause (the principal assertion) is absent |
| `row_226` | history #26 | Not Supported | correct | Not supported | Papoutsis and The Old Testament According to the Seventy by Michael Asser are based on th… |  |
| `row_227` | history #32 | Not Supported | correct | Not supported | Earhart's mother provided part of the $1,000 "stake" against her "better judgement". | contradiction |
| `row_228` | history #49 | Not Supported | wrong | Supported | These interpretations have been marked by ambiguity and subjectivity. | **excluded:** PDF source - proxy and direct fetch both return nothing |
| `row_229` | history #52 | Not Supported | correct | Not supported | Manuscripts of the LXX have been found among the Dead Sea Scrolls, and were thought to ha… |  |
| `row_230` | history #74 | Not Supported | correct | Not supported | Her acting forays were stilled at an early stage when she became ill with rheumatic fever… | contradiction |
| `row_231` | history #114 | Not Supported | correct | Partially supported | They visited the Exposition Universelle (a successor to Albert's 1851 brainchild the Grea… | NS->PS: source confirms the 1,200-guest Versailles ball, omits the other visits |
| `row_232` | history #123 | Not Supported | correct | Not supported | The Apocrypha are included under a separate heading in the King James Version of the Bibl… |  |
| `row_233` | history #139 | Not Supported | wrong | Supported | Marie Tussaud was employed to make a death mask of her head. |  |
| `row_234` | history #155 | Not Supported | correct | Not supported | These copies of the LXX include books known as anagignoskomena in Greek and, in English, … | kept NS: the terminology/etymology claims are the principal assertion |
| `row_235` | history #166 | Not Supported | correct | Partially supported | A small but comprehensive collection of sculpture from the Indian subcontinent, including… | NS->PS: source confirms the Amaravati collection and reliefs, omits Elliot |
| `row_236` | history #194 | Not Supported | correct | Not supported | "The Lexham English Septuagint (LES), then, is the only contemporary English translation … | **excluded:** WorldCat record - proxy fetch fails and no Wayback snapshot exists |
| `row_237` | history #209 | Partially Supported | wrong | Supported | In 2012, Lexham Press published the Lexham English Septuagint (LES), providing a literal,… | evidence is in tabular data on the page |
| `row_238` | contentious topics #4 | Not Supported | wrong | Supported | On March 1, 2025, Trump signed an executive order designating English as the country's of… | date given only as "on Saturday" plus the dateline |
| `row_239` | contentious topics #35 | Not Supported | wrong | Supported | ISIS has also kidnapped foreign-aid workers and Syrians who work for foreign-funded group… | **excluded:** paywall stub (WSJ) - article body never retrieved |
| `row_240` | contentious topics #40 | Not Supported | wrong | Supported | Stylistically, her music has been described as dance-pop, | pronoun subject ("her"): supported once the subject is known |
| `row_241` | contentious topics #42 | Not Supported | correct | Not supported | A remix of "These Walls" featuring Belgian singer Pierre de Maere, was released as the fo… | kept NS: release as the fourth single on 8 November (the principal assertion) is absent |
| `row_242` | contentious topics #55 | Partially Supported | correct | Partially supported | The struggle is similar to that of the 16th-century reformation in Christianity, and in f… |  |
| `row_243` | contentious topics #172 | Not Supported | correct | Not supported | Since at least the 1990s, Islamist terrorist incidents have occurred around the world and… |  |
| `row_244` | dubious #39 | Not Supported | correct | Not supported | First Congress leader to become Chief Minister, and first Ezhava to hold the post. |  |
| `row_245` | dubious #58 | Not Supported | correct | Not supported | The status of the Colonial Spanish horse is considered threatened overall with seven indi… | live page changed since citation; the current page contradicts the claim |
| `row_246` | dubious #105 | Not Supported | correct | Partially supported | It was subsequently popularized in this sense in 1997 by Dickson in his book Labels for L… | NS->PS: the reviewer said "partially supported"; **excluded:** archive banner only - snapshot is a redirect with no article behind it |
| `row_247` | failed-verification #20 | Not Supported | correct | Partially supported | Filming continued at Fox (where most of the shooting was done) and New Orleans, Louisiana. | NS->PS: source confirms New Orleans, omits Fox |
| `row_248` | failed-verification #21 | Not Supported | correct | Not supported | John Draper, an academic and political commentator, noted that the rise of fascism in Tha… | kept NS: the 2014 start date (the principal assertion) is absent |
| `row_249` | failed-verification #22 | Not Supported | correct | Not supported | Before the 2007–2008 Writers Guild of America strike began, James Vanderbilt and Scott Si… |  |
| `row_250` | failed-verification #130 | Not Supported | correct | Not supported | He is also the co-creator of The Story Collider, a science-based story telling podcast re… |  |
| `row_251` | failed-verification #157 | Not Supported | correct | Not supported | It takes place every July to September. | contradiction |
| `row_252` | failed-verification #186 | Not Supported | correct | Not supported | These issues have since been resolved and Nyan Cat made his return to the game in the sum… | contradiction |
| `row_253` | ai-generated #14 | Not Supported | correct | Partially supported | Syrian state media echoed these claims, and the overall effort encompassed over 40 articl… | NS->PS: source confirms the Russian/pro-Assad campaign, omits state media and the 40 articles |
| `row_254` | ai-generated #15 | Partially Supported | correct | Partially supported | Estefan Cortes-Vargas (born Estefania Cortes-Vargas, 1991) is a Colombian-born Canadian p… |  |
| `row_255` | ai-generated #16 | Partially Supported | correct | Partially supported | The boats built in Sibu are often exported to neighbouring state of Sabah, Peninsular Mal… |  |
| `row_256` | ai-generated #19 | Not Supported | correct | Not supported | Digital literacy initially focused on digital skills and stand-alone computers, but the a… |  |
| `row_257` | ai-generated #109 | Not Supported | correct | Not supported | The church was officially consecrated as a Greek Orthodox place of worship in 2023, marki… | contradiction |
| `row_258` | ai-generated #192 | Not Supported | wrong | Supported | All the 9 landmarks can be reached by 2 kilometres of walking distance from each other. |  |
| `row_259` | ai-generated #203 | Not Supported | correct | Not supported | Randt made his debut in 2009 with Leuchtspielhaus, a novel that introduced his characteri… | contradiction |
| `row_260` | ga-candidates #26 | Partially Supported | correct | Not supported | A popular fan theory which has been explored within the Doctor Who continuity is "Season … | PS->NS: source gives 1995, claim says 1996 (a contradiction is Not supported under the rubric) |
| `row_261` | ga-candidates #61 | Partially Supported | wrong | Supported | Meredith Brown at Upcoming Horror Films scored it 6 out of 10, saying it has "sharp-witte… |  |
| `row_262` | ga-candidates #74 | Not Supported | wrong | Supported | It would also be played by Weir's RatDog after the dissolution of the Grateful Dead. | pronoun subject ("It"): supported once the subject is known |
| `row_263` | npp #12 | Not Supported | correct | Not supported | and obtained a master's degree in business and economic law from the University Carlo Cat… |  |
| `row_264` | npp #130 | Not Supported | correct | Partially supported | Darts Corner has also reported that Shot has signed or sponsored professional players inc… | NS->PS: source confirms Edhouse, omits Ben Robb |

### Rows not imported

| Sheet | Model said | Reviewer | Why not | Claim |
|---|---|---|---|---|
| evergreen #16 | Not Supported | wrong | reviewer marked the claim incomplete | 11 Aryna Sabalenka in the second round in three sets. |
| evergreen #69 | Not Supported | wrong | group verdict over 2 sources; benchmark rows are single-source | $38 million |
| evergreen #70 | Not Supported | wrong | claim is a fragment, and the reviewer label rests on an inference | and the league's only African-American majority owner. |
| evergreen #71 | Not Supported | unsure | reviewer unsure | He was patron of the Anglo-Norse Society in London, formerly together… |
| evergreen #74 | Not Supported | wrong | claim is a bare list item ("Szindbád (1971)") that only reads as a claim with section context | Szindbád (1971) |
| evergreen #75 | Partially Supported | unsure | reviewer unsure | In December 2024, it was announced that the film would have its world… |
| evergreen #79 | Not Supported | unsure | reviewer unsure | The film entered 100 Crore Club on 7 September 2026, collecting over … |
| evergreen #84 | Partially Supported | wrong | label depends on the source version (original article partial, updated one full) | The injunction applied specifically to some of the money the administ… |
| evergreen #85 | Not Supported | wrong | reviewer marked the claim incomplete | The Decline of the American Empire (1986) |
| evergreen #86 | Not Supported | wrong | group verdict over 2 sources; benchmark rows are single-source | Tidalwave Productions. |
| evergreen #87 | Partially Supported | correct | group verdict over 3 sources; benchmark rows are single-source | Robert Carradine, American actor (voice of Lewis Skolnick in the Robo… |
| evergreen #88 | Not Supported | unsure | reviewer unsure | The Independent Workers' Union of Great Britain (IWGB) criticised Roc… |
| evergreen #90 | Not Supported | unsure | reviewer unsure | Olise was "gangly" and "not very strong" to endure physical challenge… |
| evergreen #377 | Not Supported | wrong | reviewer marked the claim incomplete | 7 Zheng Qinwen in straight sets to reach the semifinals. |
| evergreen #470 | Not Supported | wrong | group verdict over 2 sources; benchmark rows are single-source | and Bosnia and Herzegovina |
| evergreen #554 | Not Supported | correct | reviewer marked the claim incomplete | Liudmila Samsonova, and Lauren Davis |
| evergreen #583 | Not Supported | unsure | reviewer unsure | Comoros is the only Arabic-speaking country entirely in the Southern … |
| evergreen #1625 | Partially Supported | unsure | reviewer unsure | Parton was the subject of the NPR podcast Dolly Parton's America, hos… |
| evergreen #2231 | Partially Supported | unsure | reviewer unsure | On June 29, 2014, Parton performed for the first time at the UK Glast… |
| evergreen #2274 | Partially Supported | unsure | reviewer unsure | In November 2020, Parton produced and starred in the Netflix musical … |
| blp #23 | Not Supported | unsure | group verdict over 2 sources; benchmark rows are single-source | He was the Deputy Chair of the Board of the National Film and Sound A… |
| blp #26 | Not Supported | wrong | claim is a fragment ("His younger twin sisters Breanna") | His younger twin sisters Breanna |
| blp #27 | Not Supported | wrong | reviewer judged the claim against another citation's source, not this one | Following the release of Citizen Vigilante in late June 2026 and its … |
| blp #29 | Not Supported | unsure | reviewer unsure | She was expelled in December 2010 for skipping classes. |
| blp #31 | Not Supported | correct | group verdict over 2 sources; benchmark rows are single-source | He contested 2015 and 2020 Assembly Election on the ticket of Bhartiy… |
| blp #96 | Not Supported | wrong | group verdict over 2 sources; benchmark rows are single-source | On August 24, 2010, Norman defeated Ambler. |
| blp #108 | Not Supported | unsure | reviewer unsure | Dale is best known for development of improved strains of bananas. |
| blp #132 | Not Supported | unsure | reviewer unsure | BloodRayne: The Third Reich, In the Name of the King, In the Name of … |
| blp #156 | Not Supported | unsure | reviewer unsure | Boll's early releases in North America were the horror movie Blackwoo… |
| history #17 | Not Supported | unsure | reviewer unsure | The statue was designed by Hamo Thornycroft, cast in bronze by Singer… |
| history #58 | Not Supported | unsure | reviewer unsure | It exists in two major versions: the longer and more heavily fictiona… |
| history #76 | Partially Supported | unsure | reviewer unsure | In January 1847 she personally donated £2,000 (equivalent to between … |
| history #79 | Not Supported | unsure | reviewer unsure | using the text of the 2006 revised edition of Rahlf's Septuaginta. |
| history #145 | Not Supported | unsure | reviewer unsure | A New English Translation of the Septuagint and the Other Greek Trans… |
| history #182 | Not Supported | correct | paywalled: reviewer saw only a preview and could not confirm | From the time of Herodotus, a minority of geographers have rejected t… |
| history #270 | Not Supported | unsure | reviewer unsure | The first king of the Swedes, Eric, was married to Gunhild, of the Po… |
| contentious topics #34 | Not Supported | unsure | group verdict over 3 sources; benchmark rows are single-source | 2024 —————————— TBA "Scornful Woman" |
| contentious topics #36 | Not Supported | — | not annotated (no verdict assessment) | Future Nostalgia peaked at number one on the Official UK Albums Chart… |
| contentious topics #37 | Not Supported | — | not annotated (no verdict assessment) | Associated with Jacobin, Catalyst: A Journal of Theory and Strategy i… |
| contentious topics #38 | Not Supported | — | not annotated (no verdict assessment) | Recently, Khan opened up about her hardships moving to Mumbai after e… |
| contentious topics #39 | Not Supported | — | not annotated (no verdict assessment) | ↑ "Feeling Purdy Good" did not enter the Billboard Hot 100, but peake… |
| contentious topics #41 | Not Supported | unsure | reviewer unsure | and Germany have faced multiple attacks, |
| contentious topics #80 | Not Supported | wrong | reviewer marked the claim incomplete | Al-Qaeda's splinter groups and competitors, Jama'at al-Tawhid wal-Jih… |
| contentious topics #159 | Not Supported | unsure | reviewer unsure | According to The New York Times, "Hamas has recognized the pull such … |
| contentious topics #178 | Not Supported | unsure | reviewer unsure | Consequently, she became Erica Salazar. |
| contentious topics #297 | Not Supported | unsure | reviewer unsure | Similarly, Timothy Winter writes that the proclamations of bin Laden … |
| contentious topics #316 | Not Supported | wrong | reviewer marked the extracted URLs wrong; evidence sits behind a "Read more" fold | In 2019, the revocation of Article 370 of the Constitution of India c… |
| dubious #5 | Not Supported | wrong | claim is a table cell ("Mexico → Azteca") | Mexico → Azteca |
| dubious #10 | Not Supported | wrong | the URL holding the evidence wasn't extracted; reviewer judged a different source | In terms of income, over 50 per cent of Argentines lived below the of… |
| dubious #11 | Partially Supported | unsure | reviewer unsure | On 12 October 2012, Irish Naval Service ship LÉ Róisín was reported e… |
| dubious #12 | Not Supported | unsure | reviewer unsure | Greenpeace visits and a 42-day record Flag of the self-proclaimed "Gl… |
| failed-verification #31 | Not Supported | unsure | reviewer unsure | It is found on Java and Sumatra. |
| failed-verification #33 | Not Supported | unsure | group verdict over 3 sources; benchmark rows are single-source | ↑ .mw-parser-output .IPA-label-small{font-size:85%}.mw-parser-output … |
| ai-generated #28 | Not Supported | correct | group verdict over 2 sources; benchmark rows are single-source | British journalist Vanessa Beeley contributed to the effort through a… |
| ai-generated #158 | Not Supported | wrong | reviewer marked the claim incomplete | It is available at almost all coffee shops and food stalls. |
| ai-generated #228 | Not Supported | correct | group verdict over 2 sources; benchmark rows are single-source | The campaign involved pro-Russian European journalists based in Swede… |
| ga-candidates #9 | Not Supported | wrong | claim is a two-word fragment ("Battle royale") | Battle royale |
| ga-candidates #14 | Not Supported | wrong | page is now empty; evidence only in an uncited archive snapshot | the Whitbread Prize, |
| ga-candidates #24 | Not Supported | wrong | paywalled (WSJ) | McDonald appeared before the Senate Committee on the Judiciary on Feb… |
| ga-candidates #25 | Not Supported | wrong | "restored" depends on an earlier claim in the article | Sunday service was restored from the December 2015 timetable. |
| ga-candidates #286 | Not Supported | unsure | group verdict over 2 sources; benchmark rows are single-source | "It would have been a tough loss having been 7–2 in front." |
| npp #2 | Not Supported | correct | group verdict over 2 sources; benchmark rows are single-source | The team has made 10 NCAA Tournament appearances, reached the nationa… |
| npp #6 | Not Supported | wrong | reviewer marked the claim incomplete | Founding member |
| npp #20 | Not Supported | wrong | paywalled (The Bookseller) | Via a four-way auction and two-book deal in 2022, Hot Key Books (a Bo… |
