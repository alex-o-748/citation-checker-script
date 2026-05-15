# Compare Results — 2026-05-15T05:38:34.294Z

Change axes: `prompt`, `source_text`
Control run at: 2026-05-15T05:05:32.297Z
Treatment run at: 2026-05-15T05:20:51.857Z

Compared cells: **1600** of 1600 intersection (11 control-only, 13 treatment-only excluded). Dataset: 181 valid of 189.
Noise floor: ±5pp (single-provider 95% CI heuristic).

## Headline accuracy

| Provider | n | Control exact | Treatment exact | Δ exact | Control lenient | Treatment lenient | Δ lenient | Control binary | Treatment binary | Δ binary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| hf-gpt-oss-20b | 157 | 59.2% | 65.6% | +6.4 | 70.1% | 80.3% | +10.2 | 70.1% | 80.3% | +10.2 |
| hf-qwen3-32b (noise) | 181 | 59.7% | 63.0% | +3.3 | 75.7% | 79.6% | +3.9 | 80.7% | 84.0% | +3.3 |
| openrouter-mistral-small-3.2 (noise) | 181 | 42.5% | 47.0% | +4.4 | 67.4% | 70.7% | +3.3 | 82.9% | 78.5% | -4.4 |
| gemini-2.5-flash (noise) | 177 | 65.5% | 67.2% | +1.7 | 78.0% | 80.2% | +2.3 | 79.1% | 82.5% | +3.4 |
| claude-sonnet-4-5 | 181 | 42.5% | 58.6% | +16.0 | 58.0% | 77.9% | +19.9 | 70.2% | 80.1% | +9.9 |
| openrouter-gemma-4-26b-a4b | 181 | 53.6% | 61.9% | +8.3 | 66.9% | 79.6% | +12.7 | 80.7% | 81.2% | +0.6 |
| hf-deepseek-v3 | 181 | 44.2% | 65.7% | +21.5 | 65.2% | 79.6% | +14.4 | 83.4% | 85.1% | +1.7 |
| openrouter-granite-4.1-8b | 181 | 55.8% | 65.7% | +9.9 | 66.9% | 77.9% | +11.0 | 70.7% | 79.6% | +8.8 |
| openrouter-qwen-3-32b (noise) | 180 | 60.6% | 60.6% | +0.0 | 74.4% | 76.7% | +2.2 | 83.9% | 80.0% | -3.9 |

## Flips

| Provider | Entry ID | Claim | Control | Treatment | Ground truth | Direction |
|---|---|---|---|---|---|---|
| hf-qwen3-32b | row_2 | Immigration has been a major source of population growth and… | Partially supported | Supported | Supported | improvement |
| hf-deepseek-v3 | row_3 | While the United States represented about 4% of the total gl… | Source unavailable | Not supported | Partially supported | lateral |
| claude-sonnet-4-5 | row_3 | While the United States represented about 4% of the total gl… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-mistral-small-3.2 | row_3 | While the United States represented about 4% of the total gl… | Supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_8 | persons admitted under the Nicaraguan and Central American R… | Not supported | Partially supported | Supported | lateral |
| openrouter-granite-4.1-8b | row_4 | In March 2025, the Federation for American Immigration Refor… | PARSE_ERROR | Supported | Supported | improvement |
| gemini-2.5-flash | row_10 | Census estimates show 45.3 million foreign born residents in… | Not supported | Partially supported | Partially supported | improvement |
| gemini-2.5-flash | row_11 | In 2017, out of the U.S. foreign-born population, some 45% (… | Not supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_9 | of these ethnic quotas with per-country limits for family-sp… | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_9 | of these ethnic quotas with per-country limits for family-sp… | Not supported | Partially supported | Supported | lateral |
| claude-sonnet-4-5 | row_7 | and 1.0% who were granted the Special Immigrant Visa (SIV) f… | Source unavailable | Not supported | Supported | lateral |
| openrouter-mistral-small-3.2 | row_5 | In 2024, immigrants and their U.S.-born children number more… | Supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_3 | While the United States represented about 4% of the total gl… | Partially supported | Not supported | Partially supported | regression |
| hf-deepseek-v3 | row_9 | of these ethnic quotas with per-country limits for family-sp… | Source unavailable | Supported | Supported | improvement |
| claude-sonnet-4-5 | row_8 | persons admitted under the Nicaraguan and Central American R… | Source unavailable | Not supported | Supported | lateral |
| hf-deepseek-v3 | row_10 | Census estimates show 45.3 million foreign born residents in… | Supported | Partially supported | Partially supported | improvement |
| gemini-2.5-flash | row_24 | On 7 January 2026, Yemeni government forces (Presidential Le… | Not supported | Partially supported | Supported | lateral |
| hf-gpt-oss-20b | row_16 | Over half of all European immigrants to Colonial America dur… | Supported | Not supported | Supported | regression |
| hf-deepseek-v3 | row_14 | Causes of migration include poverty, crime | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_16 | Over half of all European immigrants to Colonial America dur… | Partially supported | Supported | Supported | improvement |
| openrouter-gemma-4-26b-a4b | row_7 | and 1.0% who were granted the Special Immigrant Visa (SIV) f… | Source unavailable | Not supported | Supported | lateral |
| claude-sonnet-4-5 | row_15 | During the 17th century, approximately 400,000 English peopl… | Partially supported | Not supported | Supported | lateral |
| hf-deepseek-v3 | row_15 | During the 17th century, approximately 400,000 English peopl… | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_20 | After an initial wave of immigration from China following th… | Partially supported | Source unavailable | Not supported | lateral |
| claude-sonnet-4-5 | row_20 | After an initial wave of immigration from China following th… | Source unavailable | Not supported | Not supported | improvement |
| hf-gpt-oss-20b | row_24 | On 7 January 2026, Yemeni government forces (Presidential Le… | Not supported | Partially supported | Supported | lateral |
| claude-sonnet-4-5 | row_24 | On 7 January 2026, Yemeni government forces (Presidential Le… | Not supported | Partially supported | Supported | lateral |
| claude-sonnet-4-5 | row_25 | Following Aden's capture, the secretary-general of the STC a… | Not supported | Partially supported | Supported | lateral |
| hf-qwen3-32b | row_25 | Following Aden's capture, the secretary-general of the STC a… | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_29 | On 7 January 2026, Saudi Arabia launched airstrikes against … | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_29 | On 7 January 2026, Saudi Arabia launched airstrikes against … | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_32 | The STC maintains that Zoubaidi remains in Aden. | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_33 | The Yemeni government charged Zoubaidi with high treason on … | Partially supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_7 | and 1.0% who were granted the Special Immigrant Visa (SIV) f… | Source unavailable | Partially supported | Supported | lateral |
| gemini-2.5-flash | row_55 | Gehry originally called the house Ginger and Fred (after the… | Not supported | Partially supported | Supported | lateral |
| hf-gpt-oss-20b | row_34 | The flag of Yemen was raised over government buildings in th… | Not supported | Supported | Supported | improvement |
| claude-sonnet-4-5 | row_37 | Fighting broke out between the Houthis and army units in nor… | Supported | Partially supported | Supported | regression |
| openrouter-gemma-4-26b-a4b | row_9 | of these ethnic quotas with per-country limits for family-sp… | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_40 | That evening, Benomar announced an agreement that would end … | Partially supported | Not supported | Supported | lateral |
| openrouter-mistral-small-3.2 | row_10 | Census estimates show 45.3 million foreign born residents in… | Supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_44 | The rebels signed a deal with the government, prompting Prim… | Partially supported | Supported | Supported | improvement |
| hf-qwen3-32b | row_41 | By 21 September, the Houthis declared themselves in control … | Supported | Not supported | Supported | regression |
| openrouter-qwen-3-32b | row_9 | of these ethnic quotas with per-country limits for family-sp… | Not supported | Supported | Supported | improvement |
| hf-deepseek-v3 | row_42 | having taken over the offices of the prime minister, the sta… | Supported | Partially supported | Partially supported | improvement |
| gemini-2.5-flash | row_68 | The original settlement area contained the site of the Chart… | Partially supported | Supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_11 | In 2017, out of the U.S. foreign-born population, some 45% (… | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_46 | Al Jazeera later claimed to have received taped phone conver… | Partially supported | Supported | Supported | improvement |
| claude-sonnet-4-5 | row_49 | They stepped up their efforts by shelling Hadi's residence a… | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_45 | However, the group maintained control of key points in the c… | Supported | Partially supported | Supported | regression |
| hf-deepseek-v3 | row_43 | although the general himself was believed to have escaped ca… | Partially supported | Supported | Supported | improvement |
| openrouter-granite-4.1-8b | row_11 | In 2017, out of the U.S. foreign-born population, some 45% (… | Supported | Partially supported | Partially supported | improvement |
| gemini-2.5-flash | row_75 | According to various estimates, the number of Chechens who a… | Partially supported | Supported | Not supported | lateral |
| claude-sonnet-4-5 | row_50 | In the 1930s, Chechnya was flooded with multiple Ukrainians … | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_48 | The Houthis continued to apply pressure on the weakened unit… | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_50 | In the 1930s, Chechnya was flooded with multiple Ukrainians … | Partially supported | Supported | Partially supported | regression |
| hf-deepseek-v3 | row_49 | They stepped up their efforts by shelling Hadi's residence a… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_50 | In the 1930s, Chechnya was flooded with multiple Ukrainians … | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_54 | President Maskhadov started a major campaign against hostage… | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_55 | Gehry originally called the house Ginger and Fred (after the… | Not supported | Partially supported | Supported | lateral |
| hf-gpt-oss-20b | row_55 | Gehry originally called the house Ginger and Fred (after the… | Not supported | Partially supported | Supported | lateral |
| gemini-2.5-flash | row_92 | His poetry has appeared in various publications, such as Con… | Not supported | Source unavailable | Not supported | regression |
| claude-sonnet-4-5 | row_60 | AJMN receives public funding from the Qatari government, and… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_15 | During the 17th century, approximately 400,000 English peopl… | Not supported | Partially supported | Supported | lateral |
| claude-sonnet-4-5 | row_61 | AJMN receives public funding from the Qatari government, and… | Not supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_57 | Gehry himself later discarded his own idea, as he was "afrai… | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_57 | Gehry himself later discarded his own idea, as he was "afrai… | Partially supported | Supported | Supported | improvement |
| openrouter-granite-4.1-8b | row_15 | During the 17th century, approximately 400,000 English peopl… | Partially supported | Supported | Supported | improvement |
| hf-deepseek-v3 | row_56 | but the nickname Ginger & Fred is now mainly used for the re… | Supported | Partially supported | Supported | regression |
| gemini-2.5-flash | row_97 | Shreve's literary works have been featured in The New Yorker… | Not supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_61 | AJMN receives public funding from the Qatari government, and… | Not supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_61 | AJMN receives public funding from the Qatari government, and… | Source unavailable | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_17 | The Census Bureau published preliminary estimates of the ori… | Not supported | Source unavailable | Supported | lateral |
| hf-deepseek-v3 | row_60 | AJMN receives public funding from the Qatari government, and… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_61 | AJMN receives public funding from the Qatari government, and… | Supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_15 | During the 17th century, approximately 400,000 English peopl… | Partially supported | Not supported | Supported | lateral |
| claude-sonnet-4-5 | row_66 | In 2005, the Qatari officials were reportedly so concerned b… | Supported | Partially supported | Supported | regression |
| gemini-2.5-flash | row_107 | In 2009, Fennessy founded and became CEO of Standard Media I… | Not supported | Source unavailable | Not supported | regression |
| openrouter-mistral-small-3.2 | row_19 | By comparison, in the first federal census, in 1790, the pop… | Supported | Source unavailable | Supported | regression |
| hf-gpt-oss-20b | row_65 | Al Jazeera's first day on air was 1 November 1996. It offere… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_20 | After an initial wave of immigration from China following th… | Source unavailable | Partially supported | Not supported | lateral |
| claude-sonnet-4-5 | row_69 | On December 15, 1814, delegates from the five New England st… | Not supported | Partially supported | Supported | lateral |
| hf-deepseek-v3 | row_64 | The original Al Jazeera Satellite Channel was launched on 1 … | Supported | Partially supported | Supported | regression |
| hf-gpt-oss-20b | row_68 | The original settlement area contained the site of the Chart… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_20 | After an initial wave of immigration from China following th… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_65 | Al Jazeera's first day on air was 1 November 1996. It offere… | Supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_20 | After an initial wave of immigration from China following th… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_21 | The peak year of European immigration was in 1907, when 1,28… | Not supported | Partially supported | Supported | lateral |
| claude-sonnet-4-5 | row_73 | The rebels proceeded to take the hostages to an unknown hidi… | Not supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_70 | The case continued until 15 December 2025, when the Supreme … | Partially supported | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_74 | On 16 July, the French yacht Dignité Al Karama left the Gree… | Source unavailable | Not supported | Not supported | improvement |
| hf-gpt-oss-20b | row_70 | The case continued until 15 December 2025, when the Supreme … | Not supported | Partially supported | Not supported | regression |
| hf-deepseek-v3 | row_68 | The original settlement area contained the site of the Chart… | Supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_75 | According to various estimates, the number of Chechens who a… | Partially supported | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_80 | A key issue in the motion was the Prime Minister's alleged i… | Not supported | Partially supported | Not supported | regression |
| hf-deepseek-v3 | row_70 | The case continued until 15 December 2025, when the Supreme … | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_79 | His educational background is in marine biology, and Hemphil… | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_72 | On 23 July 1992, the Abkhaz faction of Abkhazia's legislativ… | Partially supported | Supported | Partially supported | regression |
| claude-sonnet-4-5 | row_82 | Joseph Constant, sculptor and writer | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_74 | On 16 July, the French yacht Dignité Al Karama left the Gree… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_84 | Cenat is Catholic. | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_75 | According to various estimates, the number of Chechens who a… | Partially supported | Supported | Not supported | lateral |
| claude-sonnet-4-5 | row_81 | In 1985 he gave the UK premiere of Erich Wolfgang Korngold's… | Not supported | Partially supported | Not supported | regression |
| openrouter-granite-4.1-8b | row_24 | On 7 January 2026, Yemeni government forces (Presidential Le… | Partially supported | Supported | Supported | improvement |
| gemini-2.5-flash | row_138 | Raul is known to be a strong proponent of Flock Safety ALPR … | Supported | Partially supported | Partially supported | improvement |
| gemini-2.5-flash | row_137 | LaGuardia Airport, United States, 2025 | Partially supported | Supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_25 | Following Aden's capture, the secretary-general of the STC a… | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_89 | University Radio York (URY) is the oldest independent radio … | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_91 | The brigade has faced accusations of human rights abuses, in… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_76 | In 2002, Rwanda's situation in the war began to worsen. Many… | Supported | Partially supported | Not supported | lateral |
| hf-deepseek-v3 | row_79 | His educational background is in marine biology, and Hemphil… | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_81 | In 1985 he gave the UK premiere of Erich Wolfgang Korngold's… | Partially supported | Supported | Not supported | lateral |
| claude-sonnet-4-5 | row_90 | In June, Ajnad al-Sham along with more rebel groups led a ne… | Not supported | Partially supported | Not supported | regression |
| claude-sonnet-4-5 | row_93 | The economy of Clinton, along with the surrounding Island Co… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_26 | Aden has changed hands several times over the course of the … | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_94 | A new church was designed by Sir George Gilbert Scott, one o… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_95 | The global electricity consumption in 2022 was 24,398 terawa… | Source unavailable | Not supported | Partially supported | lateral |
| hf-deepseek-v3 | row_82 | Joseph Constant, sculptor and writer | Source unavailable | Not supported | Not supported | improvement |
| gemini-2.5-flash | row_151 | The team won the North II Group III state sectional champion… | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_81 | In 1985 he gave the UK premiere of Erich Wolfgang Korngold's… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_84 | Cenat is Catholic. | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_27 | A few weeks later, the Battle of Aden broke out between the … | PARSE_ERROR | Supported | Supported | improvement |
| gemini-2.5-flash | row_155 | COM is well regarded among communication colleges in the Uni… | Not supported | Partially supported | Not supported | regression |
| openrouter-gemma-4-26b-a4b | row_27 | A few weeks later, the Battle of Aden broke out between the … | Not supported | Partially supported | Supported | lateral |
| hf-qwen3-32b | row_88 | Kask died after a short illness on December 30, 2025, at the… | Partially supported | Supported | Supported | improvement |
| hf-gpt-oss-20b | row_88 | Kask died after a short illness on December 30, 2025, at the… | Not supported | Partially supported | Supported | lateral |
| hf-deepseek-v3 | row_86 | Massoud also highlighted the NRF's operational shift to guer… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_100 | and the Minister of Interior in the Syrian transitional gove… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_87 | It was the unofficial remake of Hollywood film Love Actually… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_101 | However, it has been since extended indefinitely. | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_89 | University Radio York (URY) is the oldest independent radio … | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_93 | The economy of Clinton, along with the surrounding Island Co… | Partially supported | Source unavailable | Not supported | lateral |
| claude-sonnet-4-5 | row_108 | The magazine secures much of its material from "insider" sou… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_91 | The brigade has faced accusations of human rights abuses, in… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_93 | The economy of Clinton, along with the surrounding Island Co… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_107 | In 2009, Fennessy founded and became CEO of Standard Media I… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_110 | The song is based on a poem written by a young Oklahoma war … | Source unavailable | Not supported | Not supported | improvement |
| gemini-2.5-flash | row_169 | However, it is most often found in open woodlands, along the… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_95 | The global electricity consumption in 2022 was 24,398 terawa… | Source unavailable | Not supported | Partially supported | lateral |
| hf-qwen3-32b | row_97 | Shreve's literary works have been featured in The New Yorker… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_26 | Aden has changed hands several times over the course of the … | Supported | Partially supported | Supported | regression |
| hf-deepseek-v3 | row_96 | On 6 March 2024, Welch made his senior debut for the club, r… | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_100 | and the Minister of Interior in the Syrian transitional gove… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_29 | On 7 January 2026, Saudi Arabia launched airstrikes against … | Partially supported | Not supported | Partially supported | regression |
| hf-deepseek-v3 | row_97 | Shreve's literary works have been featured in The New Yorker… | Source unavailable | Partially supported | Partially supported | improvement |
| gemini-2.5-flash | row_175 | On November 4, 2025, a reissue of Sequence 01 was announced,… | Not supported | Partially supported | Supported | lateral |
| hf-deepseek-v3 | row_100 | and the Minister of Interior in the Syrian transitional gove… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_101 | However, it has been since extended indefinitely. | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_103 | Varisu and Animal rank among the highest-grossing Indian fil… | Not supported | Partially supported | Not supported | regression |
| openrouter-granite-4.1-8b | row_31 | After Aden's fall to the PLC, Zoubaidi went missing for a br… | PARSE_ERROR | Supported | Supported | improvement |
| hf-deepseek-v3 | row_102 | and classified among "R1: Doctoral Universities – Very high … | Source unavailable | Not supported | Partially supported | lateral |
| hf-qwen3-32b | row_105 | Harris's body was cremated, and his ashes were scattered in … | Source unavailable | Not supported | Not supported | improvement |
| gemini-2.5-flash | row_183 | The following year, qualification was achieved for the FIFA … | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_104 | As of December 2024, the company operates six locations: one… | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_108 | The magazine secures much of its material from "insider" sou… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_105 | Harris's body was cremated, and his ashes were scattered in … | Source unavailable | Not supported | Not supported | improvement |
| gemini-2.5-flash | row_184 | It is managed as part of the Nature Reserve of Orange County… | Supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_112 | Since 2013, she has guest-starred in several episodes of Law… | Not supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_112 | Since 2013, she has guest-starred in several episodes of Law… | Supported | Not supported | Partially supported | lateral |
| hf-deepseek-v3 | row_110 | The song is based on a poem written by a young Oklahoma war … | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_128 | Republicans should be ashamed of exploiting this tragedy for… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-qwen-3-32b | row_30 | PLC forces captured the city's international airport and the… | Partially supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_31 | After Aden's fall to the PLC, Zoubaidi went missing for a br… | Supported | Partially supported | Supported | regression |
| openrouter-qwen-3-32b | row_27 | A few weeks later, the Battle of Aden broke out between the … | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_132 | Based on polo, two players moved miniature motorbikes around… | Not supported | Partially supported | Supported | lateral |
| openrouter-granite-4.1-8b | row_33 | The Yemeni government charged Zoubaidi with high treason on … | Not supported | Supported | Supported | improvement |
| claude-sonnet-4-5 | row_136 | Only to make the team feel uneasy and are feeling the strong… | Not supported | Partially supported | Supported | lateral |
| openrouter-granite-4.1-8b | row_34 | The flag of Yemen was raised over government buildings in th… | PARSE_ERROR | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_32 | The STC maintains that Zoubaidi remains in Aden. | Supported | Partially supported | Supported | regression |
| openrouter-qwen-3-32b | row_33 | The Yemeni government charged Zoubaidi with high treason on … | Not supported | Supported | Supported | improvement |
| hf-gpt-oss-20b | row_127 | In May 2025, the New York Times Children’s and Young Adult S… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_34 | The flag of Yemen was raised over government buildings in th… | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_127 | In May 2025, the New York Times Children’s and Young Adult S… | Partially supported | Supported | Partially supported | regression |
| hf-qwen3-32b | row_129 | Any movement, especially rapid or unguarded movement, can ag… | Partially supported | Supported | Supported | improvement |
| hf-deepseek-v3 | row_127 | In May 2025, the New York Times Children’s and Young Adult S… | Source unavailable | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_148 | Intrigued by the foul odors, Lukas declined the offer and le… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_37 | Fighting broke out between the Houthis and army units in nor… | PARSE_ERROR | Supported | Supported | improvement |
| hf-gpt-oss-20b | row_132 | Based on polo, two players moved miniature motorbikes around… | Not supported | Partially supported | Supported | lateral |
| claude-sonnet-4-5 | row_150 | Introduced in September 2019, it is chambered in 9×19mm Para… | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_149 | Born in Bermuda, Brunson joined Queens Park Rangers in Decem… | Supported | Partially supported | Supported | regression |
| hf-qwen3-32b | row_133 | In December 2008, Bettencourt stepped down from his role sho… | Partially supported | Supported | Supported | improvement |
| hf-qwen3-32b | row_135 | There, she completed her doctoral training and collaborated … | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_154 | The club previously played at Estadio El Vivero in the east … | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_136 | Only to make the team feel uneasy and are feeling the strong… | Supported | Partially supported | Supported | regression |
| hf-deepseek-v3 | row_132 | Based on polo, two players moved miniature motorbikes around… | Supported | Partially supported | Supported | regression |
| openrouter-granite-4.1-8b | row_39 | More than 60 were killed in clashes on 19 September. | Partially supported | Not supported | Supported | lateral |
| hf-deepseek-v3 | row_136 | Only to make the team feel uneasy and are feeling the strong… | Supported | Partially supported | Supported | regression |
| claude-sonnet-4-5 | row_156 | Production of dead burnt magnesite and further value additio… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_155 | COM is well regarded among communication colleges in the Uni… | Supported | Partially supported | Not supported | lateral |
| hf-deepseek-v3 | row_137 | LaGuardia Airport, United States, 2025 | Source unavailable | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_135 | There, she completed her doctoral training and collaborated … | Supported | Partially supported | Supported | regression |
| hf-deepseek-v3 | row_138 | Raul is known to be a strong proponent of Flock Safety ALPR … | Supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_140 | Thagunna made his Twenty20 International (T20I) debut for Ne… | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Partially supported | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_40 | That evening, Benomar announced an agreement that would end … | Not supported | Partially supported | Supported | lateral |
| openrouter-qwen-3-32b | row_37 | Fighting broke out between the Houthis and army units in nor… | Partially supported | Supported | Supported | improvement |
| hf-deepseek-v3 | row_143 | His comments on Middle Eastern politics have drawn criticism… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_41 | By 21 September, the Houthis declared themselves in control … | Not supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_40 | That evening, Benomar announced an agreement that would end … | Supported | Not supported | Supported | regression |
| claude-sonnet-4-5 | row_166 | O'Neal, president of the American Farm Bureau, Duncan eventu… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_161 | From 1968 through 2004, the majority of North Carolina voter… | Source unavailable | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_149 | Born in Bermuda, Brunson joined Queens Park Rangers in Decem… | Partially supported | Supported | Supported | improvement |
| hf-qwen3-32b | row_149 | Born in Bermuda, Brunson joined Queens Park Rangers in Decem… | Supported | Partially supported | Supported | regression |
| hf-deepseek-v3 | row_148 | Intrigued by the foul odors, Lukas declined the offer and le… | Source unavailable | Not supported | Not supported | improvement |
| hf-deepseek-v3 | row_147 | A review of the Arlacchi plan has been carried out in March … | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_42 | having taken over the offices of the prime minister, the sta… | Partially supported | Supported | Partially supported | regression |
| hf-qwen3-32b | row_151 | The team won the North II Group III state sectional champion… | Not supported | Source unavailable | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_30 | PLC forces captured the city's international airport and the… | PARSE_ERROR | Partially supported | Supported | lateral |
| hf-gpt-oss-20b | row_152 | Soundgarden was among one of the first grunge bands to be si… | Not supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_152 | Soundgarden was among one of the first grunge bands to be si… | Partially supported | Supported | Partially supported | regression |
| claude-sonnet-4-5 | row_168 | The district encompasses an area of roughly 84 square miles … | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_169 | However, it is most often found in open woodlands, along the… | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_151 | The team won the North II Group III state sectional champion… | Source unavailable | Not supported | Partially supported | lateral |
| hf-gpt-oss-20b | row_153 | Among her characters were Latina bimbo Melina (Lida and Meli… | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_171 | United Records operated during a period of rapid growth in t… | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_154 | The club previously played at Estadio El Vivero in the east … | Not supported | Source unavailable | Not supported | regression |
| claude-sonnet-4-5 | row_170 | The film was based on a real-life incident of a friend of Ba… | Not supported | Partially supported | Not supported | regression |
| hf-deepseek-v3 | row_154 | The club previously played at Estadio El Vivero in the east … | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_175 | On November 4, 2025, a reissue of Sequence 01 was announced,… | Not supported | Partially supported | Supported | lateral |
| hf-deepseek-v3 | row_153 | Among her characters were Latina bimbo Melina (Lida and Meli… | Supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_157 | During recovery, he would watch Janet Jackson's video anthol… | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_173 | First Nations peoples believe that the berry has many health… | Not supported | Partially supported | Partially supported | improvement |
| hf-qwen3-32b | row_158 | Its goal is to allow consumers to compare the overall nutrit… | Partially supported | Supported | Partially supported | regression |
| hf-deepseek-v3 | row_155 | COM is well regarded among communication colleges in the Uni… | Supported | Partially supported | Not supported | lateral |
| hf-qwen3-32b | row_159 | The college is also recognized as a Military Friendly® Schoo… | Not supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_160 | The Ihimba Hot Springs are situated on kabiulil-Katuna Road,… | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_159 | The college is also recognized as a Military Friendly® Schoo… | Source unavailable | Not supported | Partially supported | lateral |
| claude-sonnet-4-5 | row_179 | These groups are fighting for gender equailty and continuing… | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_157 | During recovery, he would watch Janet Jackson's video anthol… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_160 | The Ihimba Hot Springs are situated on kabiulil-Katuna Road,… | Supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Supported | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Supported | Partially supported | Not supported | lateral |
| hf-deepseek-v3 | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Source unavailable | Not supported | Not supported | improvement |
| claude-sonnet-4-5 | row_182 | Her father (Rameshwar) wanted a son, but despite being a gir… | Not supported | Partially supported | Partially supported | improvement |
| claude-sonnet-4-5 | row_186 | Combat Zone Wrestling (CZW) is an American independent profe… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_45 | However, the group maintained control of key points in the c… | Partially supported | Supported | Supported | improvement |
| hf-gpt-oss-20b | row_168 | The district encompasses an area of roughly 84 square miles … | Not supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_41 | By 21 September, the Houthis declared themselves in control … | Supported | Not supported | Supported | regression |
| hf-deepseek-v3 | row_166 | O'Neal, president of the American Farm Bureau, Duncan eventu… | Source unavailable | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_169 | However, it is most often found in open woodlands, along the… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_165 | The 1980 NBA Finals was dramatized in the Season 1 of HBO's … | Source unavailable | Partially supported | Not supported | lateral |
| hf-deepseek-v3 | row_167 | Other risk factors for developing adhesive capsulitis includ… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_168 | The district encompasses an area of roughly 84 square miles … | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_169 | However, it is most often found in open woodlands, along the… | Supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_47 | Saleh's party, the General People's Congress, joined the Hou… | Supported | Partially supported | Supported | regression |
| hf-gpt-oss-20b | row_173 | First Nations peoples believe that the berry has many health… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_171 | United Records operated during a period of rapid growth in t… | Source unavailable | Not supported | Not supported | improvement |
| hf-gpt-oss-20b | row_175 | On November 4, 2025, a reissue of Sequence 01 was announced,… | Not supported | Partially supported | Supported | lateral |
| openrouter-granite-4.1-8b | row_47 | Saleh's party, the General People's Congress, joined the Hou… | Partially supported | Supported | Supported | improvement |
| hf-deepseek-v3 | row_173 | First Nations peoples believe that the berry has many health… | Supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_175 | On November 4, 2025, a reissue of Sequence 01 was announced,… | Supported | Partially supported | Supported | regression |
| hf-gpt-oss-20b | row_179 | These groups are fighting for gender equailty and continuing… | Partially supported | Not supported | Partially supported | regression |
| hf-gpt-oss-20b | row_180 | In 2024, Keoghan publicly announced his relationship with Sa… | Supported | Partially supported | Supported | regression |
| hf-gpt-oss-20b | row_181 | Berguer was born in 1940 in A Coruña, Spain. | Supported | Partially supported | Supported | regression |
| hf-gpt-oss-20b | row_182 | Her father (Rameshwar) wanted a son, but despite being a gir… | Not supported | Partially supported | Partially supported | improvement |
| hf-deepseek-v3 | row_182 | Her father (Rameshwar) wanted a son, but despite being a gir… | Supported | Not supported | Partially supported | lateral |
| hf-qwen3-32b | row_186 | Combat Zone Wrestling (CZW) is an American independent profe… | PARSE_ERROR | Not supported | Partially supported | lateral |
| hf-gpt-oss-20b | row_186 | Combat Zone Wrestling (CZW) is an American independent profe… | Not supported | Partially supported | Partially supported | improvement |
| hf-gpt-oss-20b | row_187 | The summit also called upon Israel to relinquish it's occupa… | Supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_47 | Saleh's party, the General People's Congress, joined the Hou… | Partially supported | Not supported | Supported | lateral |
| hf-deepseek-v3 | row_185 | As of the 2025 season, Craig’s head coaching record at Valdo… | Supported | Not supported | Not supported | improvement |
| hf-qwen3-32b | row_189 | ISBN 9781936393466. | Source unavailable | Not supported | Supported | lateral |
| hf-deepseek-v3 | row_186 | Combat Zone Wrestling (CZW) is an American independent profe… | Supported | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_49 | They stepped up their efforts by shelling Hadi's residence a… | Partially supported | Supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_47 | Saleh's party, the General People's Congress, joined the Hou… | Supported | Partially supported | Supported | regression |
| openrouter-qwen-3-32b | row_49 | They stepped up their efforts by shelling Hadi's residence a… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_51 | On 27 August 1958, Major General Stepanov of the Military Av… | Partially supported | Supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_48 | The Houthis continued to apply pressure on the weakened unit… | Supported | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_51 | On 27 August 1958, Major General Stepanov of the Military Av… | PARSE_ERROR | Supported | Not supported | lateral |
| openrouter-granite-4.1-8b | row_52 | Aslan Maskhadov tried to concentrate power in his hands to e… | PARSE_ERROR | Supported | Partially supported | lateral |
| openrouter-granite-4.1-8b | row_53 | but victims were rarely killed. | PARSE_ERROR | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_51 | On 27 August 1958, Major General Stepanov of the Military Av… | Not supported | Partially supported | Not supported | regression |
| openrouter-qwen-3-32b | row_50 | In the 1930s, Chechnya was flooded with multiple Ukrainians … | Supported | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_54 | President Maskhadov started a major campaign against hostage… | PARSE_ERROR | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_56 | but the nickname Ginger & Fred is now mainly used for the re… | Partially supported | Supported | Supported | improvement |
| openrouter-gemma-4-26b-a4b | row_56 | but the nickname Ginger & Fred is now mainly used for the re… | Not supported | Partially supported | Supported | lateral |
| openrouter-gemma-4-26b-a4b | row_58 | Dancers Fred Astaire and Ginger Rogers are represented in th… | Supported | Partially supported | Supported | regression |
| openrouter-qwen-3-32b | row_58 | Dancers Fred Astaire and Ginger Rogers are represented in th… | Supported | Partially supported | Supported | regression |
| openrouter-gemma-4-26b-a4b | row_59 | In 2016, over the course of five months, two floors of the b… | Supported | Partially supported | Supported | regression |
| openrouter-mistral-small-3.2 | row_61 | AJMN receives public funding from the Qatari government, and… | Supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_60 | AJMN receives public funding from the Qatari government, and… | Partially supported | Not supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_62 | The Qatar cabinet nominates the network's leaders, who are t… | PARSE_ERROR | Supported | Supported | improvement |
| openrouter-gemma-4-26b-a4b | row_62 | The Qatar cabinet nominates the network's leaders, who are t… | Supported | Partially supported | Supported | regression |
| openrouter-granite-4.1-8b | row_64 | The original Al Jazeera Satellite Channel was launched on 1 … | Partially supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_65 | Al Jazeera's first day on air was 1 November 1996. It offere… | Partially supported | Supported | Partially supported | regression |
| openrouter-qwen-3-32b | row_64 | The original Al Jazeera Satellite Channel was launched on 1 … | Partially supported | Not supported | Supported | lateral |
| openrouter-mistral-small-3.2 | row_70 | The case continued until 15 December 2025, when the Supreme … | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-granite-4.1-8b | row_73 | The rebels proceeded to take the hostages to an unknown hidi… | PARSE_ERROR | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_71 | In April 1984, the LTTE formally joined a common militant fr… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_74 | On 16 July, the French yacht Dignité Al Karama left the Gree… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-mistral-small-3.2 | row_75 | According to various estimates, the number of Chechens who a… | Supported | Partially supported | Not supported | lateral |
| openrouter-qwen-3-32b | row_74 | On 16 July, the French yacht Dignité Al Karama left the Gree… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-mistral-small-3.2 | row_76 | In 2002, Rwanda's situation in the war began to worsen. Many… | Supported | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_76 | In 2002, Rwanda's situation in the war began to worsen. Many… | Not supported | Partially supported | Not supported | regression |
| openrouter-mistral-small-3.2 | row_79 | His educational background is in marine biology, and Hemphil… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_78 | to Jessica Roesler Gund, and George Gund II. | Supported | Not supported | Partially supported | lateral |
| openrouter-granite-4.1-8b | row_76 | In 2002, Rwanda's situation in the war began to worsen. Many… | Partially supported | Supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_80 | A key issue in the motion was the Prime Minister's alleged i… | Not supported | Partially supported | Not supported | regression |
| openrouter-gemma-4-26b-a4b | row_79 | His educational background is in marine biology, and Hemphil… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_79 | His educational background is in marine biology, and Hemphil… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_82 | Joseph Constant, sculptor and writer | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_81 | In 1985 he gave the UK premiere of Erich Wolfgang Korngold's… | Partially supported | Supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_84 | Cenat is Catholic. | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-granite-4.1-8b | row_83 | Retired Australian Army Major General Mick Ryan characterize… | Not supported | Supported | Partially supported | lateral |
| openrouter-granite-4.1-8b | row_84 | Cenat is Catholic. | Not supported | Partially supported | Not supported | regression |
| openrouter-mistral-small-3.2 | row_86 | Massoud also highlighted the NRF's operational shift to guer… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-qwen-3-32b | row_83 | Retired Australian Army Major General Mick Ryan characterize… | Partially supported | Supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_86 | Massoud also highlighted the NRF's operational shift to guer… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_86 | Massoud also highlighted the NRF's operational shift to guer… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_88 | Kask died after a short illness on December 30, 2025, at the… | Supported | Partially supported | Supported | regression |
| openrouter-mistral-small-3.2 | row_89 | University Radio York (URY) is the oldest independent radio … | Supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_90 | In June, Ajnad al-Sham along with more rebel groups led a ne… | Supported | Partially supported | Not supported | lateral |
| openrouter-granite-4.1-8b | row_89 | University Radio York (URY) is the oldest independent radio … | Not supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_91 | The brigade has faced accusations of human rights abuses, in… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-granite-4.1-8b | row_90 | In June, Ajnad al-Sham along with more rebel groups led a ne… | PARSE_ERROR | Partially supported | Not supported | lateral |
| openrouter-qwen-3-32b | row_91 | The brigade has faced accusations of human rights abuses, in… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_91 | The brigade has faced accusations of human rights abuses, in… | Not supported | Partially supported | Not supported | regression |
| openrouter-gemma-4-26b-a4b | row_92 | His poetry has appeared in various publications, such as Con… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_93 | The economy of Clinton, along with the surrounding Island Co… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_93 | The economy of Clinton, along with the surrounding Island Co… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_95 | The global electricity consumption in 2022 was 24,398 terawa… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-granite-4.1-8b | row_95 | The global electricity consumption in 2022 was 24,398 terawa… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-granite-4.1-8b | row_94 | A new church was designed by Sir George Gilbert Scott, one o… | PARSE_ERROR | Source unavailable | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_96 | On 6 March 2024, Welch made his senior debut for the club, r… | Not supported | Partially supported | Not supported | regression |
| openrouter-mistral-small-3.2 | row_97 | Shreve's literary works have been featured in The New Yorker… | Source unavailable | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_98 | John Zogby was born on September 3, 1948, and grew up in Uti… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_97 | Shreve's literary works have been featured in The New Yorker… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_96 | On 6 March 2024, Welch made his senior debut for the club, r… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_97 | Shreve's literary works have been featured in The New Yorker… | Source unavailable | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_98 | John Zogby was born on September 3, 1948, and grew up in Uti… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_99 | It was not until the 1950s and 1960s that Latin Music starte… | PARSE_ERROR | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_95 | The global electricity consumption in 2022 was 24,398 terawa… | Partially supported | Source unavailable | Partially supported | regression |
| openrouter-mistral-small-3.2 | row_100 | and the Minister of Interior in the Syrian transitional gove… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_99 | It was not until the 1950s and 1960s that Latin Music starte… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_98 | John Zogby was born on September 3, 1948, and grew up in Uti… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_100 | and the Minister of Interior in the Syrian transitional gove… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-mistral-small-3.2 | row_102 | and classified among "R1: Doctoral Universities – Very high … | Supported | Not supported | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_101 | However, it has been since extended indefinitely. | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_102 | and classified among "R1: Doctoral Universities – Very high … | Supported | Not supported | Partially supported | lateral |
| openrouter-mistral-small-3.2 | row_104 | As of December 2024, the company operates six locations: one… | Supported | Not supported | Not supported | improvement |
| openrouter-mistral-small-3.2 | row_105 | Harris's body was cremated, and his ashes were scattered in … | Supported | Partially supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_106 | Story of the Eye (French: Histoire de l'œil) is a 1928 novel… | Supported | Partially supported | Not supported | lateral |
| openrouter-qwen-3-32b | row_105 | Harris's body was cremated, and his ashes were scattered in … | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_106 | Story of the Eye (French: Histoire de l'œil) is a 1928 novel… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_108 | The magazine secures much of its material from "insider" sou… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_103 | Varisu and Animal rank among the highest-grossing Indian fil… | Not supported | Partially supported | Not supported | regression |
| openrouter-mistral-small-3.2 | row_109 | Olson researched the loss of HMAS Sydney in World War II for… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_109 | Olson researched the loss of HMAS Sydney in World War II for… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_106 | Story of the Eye (French: Histoire de l'œil) is a 1928 novel… | Not supported | Partially supported | Not supported | regression |
| openrouter-qwen-3-32b | row_108 | The magazine secures much of its material from "insider" sou… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_110 | The song is based on a poem written by a young Oklahoma war … | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_113 | The primary reasons for the decrease in injury when looking … | PARSE_ERROR | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_114 | The American Film Institute cites 6 contemporary reviews of … | Supported | Partially supported | Supported | regression |
| openrouter-granite-4.1-8b | row_115 | Later, in December 2025, a Gadsden County jury awarded a $77… | Not supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_114 | The American Film Institute cites 6 contemporary reviews of … | Partially supported | Not supported | Supported | lateral |
| openrouter-gemma-4-26b-a4b | row_113 | The primary reasons for the decrease in injury when looking … | Partially supported | Not supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_114 | The American Film Institute cites 6 contemporary reviews of … | Supported | Not supported | Supported | regression |
| openrouter-granite-4.1-8b | row_118 | Adas Israel has played an important role in the nation's cap… | PARSE_ERROR | Supported | Supported | improvement |
| openrouter-granite-4.1-8b | row_119 | At the time, he was a member of the House General Investigat… | PARSE_ERROR | Supported | Supported | improvement |
| openrouter-mistral-small-3.2 | row_128 | Republicans should be ashamed of exploiting this tragedy for… | Supported | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_127 | In May 2025, the New York Times Children’s and Young Adult S… | Not supported | Supported | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_128 | Republicans should be ashamed of exploiting this tragedy for… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-qwen-3-32b | row_128 | Republicans should be ashamed of exploiting this tragedy for… | Partially supported | Not supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_132 | Based on polo, two players moved miniature motorbikes around… | PARSE_ERROR | Supported | Supported | improvement |
| openrouter-gemma-4-26b-a4b | row_132 | Based on polo, two players moved miniature motorbikes around… | Partially supported | Supported | Supported | improvement |
| openrouter-mistral-small-3.2 | row_135 | There, she completed her doctoral training and collaborated … | Supported | Partially supported | Supported | regression |
| openrouter-gemma-4-26b-a4b | row_135 | There, she completed her doctoral training and collaborated … | Partially supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_134 | He has shared his experience through his book- More than jus… | Partially supported | Source unavailable | Supported | lateral |
| openrouter-gemma-4-26b-a4b | row_136 | Only to make the team feel uneasy and are feeling the strong… | Not supported | Partially supported | Supported | lateral |
| openrouter-mistral-small-3.2 | row_137 | LaGuardia Airport, United States, 2025 | Source unavailable | Supported | Partially supported | lateral |
| openrouter-qwen-3-32b | row_136 | Only to make the team feel uneasy and are feeling the strong… | Source unavailable | Partially supported | Supported | lateral |
| openrouter-gemma-4-26b-a4b | row_137 | LaGuardia Airport, United States, 2025 | Partially supported | Supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_136 | Only to make the team feel uneasy and are feeling the strong… | Supported | Not supported | Supported | regression |
| openrouter-granite-4.1-8b | row_137 | LaGuardia Airport, United States, 2025 | Partially supported | Not supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_138 | Raul is known to be a strong proponent of Flock Safety ALPR … | Supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_140 | Thagunna made his Twenty20 International (T20I) debut for Ne… | Not supported | Supported | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_140 | Thagunna made his Twenty20 International (T20I) debut for Ne… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_143 | His comments on Middle Eastern politics have drawn criticism… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_143 | His comments on Middle Eastern politics have drawn criticism… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_146 | Ibn al‐Bannāʾ al‐Marrākushī (Arabic: ابن البناء المراكشي), f… | Supported | Partially supported | Supported | regression |
| openrouter-granite-4.1-8b | row_146 | Ibn al‐Bannāʾ al‐Marrākushī (Arabic: ابن البناء المراكشي), f… | Partially supported | Supported | Supported | improvement |
| openrouter-qwen-3-32b | row_146 | Ibn al‐Bannāʾ al‐Marrākushī (Arabic: ابن البناء المراكشي), f… | Supported | Partially supported | Supported | regression |
| openrouter-gemma-4-26b-a4b | row_147 | A review of the Arlacchi plan has been carried out in March … | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_149 | Born in Bermuda, Brunson joined Queens Park Rangers in Decem… | Supported | Partially supported | Supported | regression |
| openrouter-granite-4.1-8b | row_150 | Introduced in September 2019, it is chambered in 9×19mm Para… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_151 | The team won the North II Group III state sectional champion… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-qwen-3-32b | row_151 | The team won the North II Group III state sectional champion… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_154 | The club previously played at Estadio El Vivero in the east … | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_155 | COM is well regarded among communication colleges in the Uni… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_156 | Production of dead burnt magnesite and further value additio… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_156 | Production of dead burnt magnesite and further value additio… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_155 | COM is well regarded among communication colleges in the Uni… | Not supported | Source unavailable | Not supported | regression |
| openrouter-granite-4.1-8b | row_158 | Its goal is to allow consumers to compare the overall nutrit… | PARSE_ERROR | Supported | Partially supported | lateral |
| openrouter-mistral-small-3.2 | row_159 | The college is also recognized as a Military Friendly® Schoo… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_158 | Its goal is to allow consumers to compare the overall nutrit… | Partially supported | Not supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_160 | The Ihimba Hot Springs are situated on kabiulil-Katuna Road,… | Partially supported | Not supported | Partially supported | regression |
| openrouter-qwen-3-32b | row_159 | The college is also recognized as a Military Friendly® Schoo… | Not supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_161 | From 1968 through 2004, the majority of North Carolina voter… | Supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Supported | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_161 | From 1968 through 2004, the majority of North Carolina voter… | Source unavailable | Not supported | Partially supported | lateral |
| openrouter-mistral-small-3.2 | row_163 | Route 22 Confederation/City Centre (this route operates as n… | Not supported | Supported | Partially supported | lateral |
| openrouter-qwen-3-32b | row_160 | The Ihimba Hot Springs are situated on kabiulil-Katuna Road,… | Partially supported | Not supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_163 | Route 22 Confederation/City Centre (this route operates as n… | PARSE_ERROR | Supported | Partially supported | lateral |
| openrouter-qwen-3-32b | row_162 | As of December 2025, OneNote had more than 500M+ downloads o… | Supported | Partially supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_165 | The 1980 NBA Finals was dramatized in the Season 1 of HBO's … | Supported | Partially supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_166 | O'Neal, president of the American Farm Bureau, Duncan eventu… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_164 | Some mentionable connections and collaborations from this pe… | PARSE_ERROR | Source unavailable | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_166 | O'Neal, president of the American Farm Bureau, Duncan eventu… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_167 | Other risk factors for developing adhesive capsulitis includ… | Partially supported | Not supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_169 | However, it is most often found in open woodlands, along the… | PARSE_ERROR | Supported | Partially supported | lateral |
| openrouter-granite-4.1-8b | row_168 | The district encompasses an area of roughly 84 square miles … | Partially supported | Supported | Partially supported | regression |
| openrouter-gemma-4-26b-a4b | row_169 | However, it is most often found in open woodlands, along the… | Supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_170 | The film was based on a real-life incident of a friend of Ba… | Supported | Partially supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_170 | The film was based on a real-life incident of a friend of Ba… | Not supported | Partially supported | Not supported | regression |
| openrouter-mistral-small-3.2 | row_171 | United Records operated during a period of rapid growth in t… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-granite-4.1-8b | row_170 | The film was based on a real-life incident of a friend of Ba… | Partially supported | Supported | Not supported | lateral |
| openrouter-gemma-4-26b-a4b | row_171 | United Records operated during a period of rapid growth in t… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-granite-4.1-8b | row_171 | United Records operated during a period of rapid growth in t… | PARSE_ERROR | Not supported | Not supported | improvement |
| openrouter-qwen-3-32b | row_171 | United Records operated during a period of rapid growth in t… | Source unavailable | Not supported | Not supported | improvement |
| openrouter-gemma-4-26b-a4b | row_173 | First Nations peoples believe that the berry has many health… | Supported | Partially supported | Partially supported | improvement |
| openrouter-granite-4.1-8b | row_174 | Future missions may use radiation-resistant fungi-derived pa… | Partially supported | Supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_175 | On November 4, 2025, a reissue of Sequence 01 was announced,… | Not supported | Partially supported | Supported | lateral |
| openrouter-qwen-3-32b | row_168 | The district encompasses an area of roughly 84 square miles … | Not supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_177 | As of 2025, the Final Fantasy series was won 10 awards at Th… | Source unavailable | Partially supported | Not supported | lateral |
| openrouter-mistral-small-3.2 | row_178 | This creates a new way for native areas to get extra revenue… | Supported | Partially supported | Partially supported | improvement |
| openrouter-gemma-4-26b-a4b | row_180 | In 2024, Keoghan publicly announced his relationship with Sa… | Supported | Partially supported | Supported | regression |
| openrouter-qwen-3-32b | row_179 | These groups are fighting for gender equailty and continuing… | Partially supported | Supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_182 | Her father (Rameshwar) wanted a son, but despite being a gir… | Partially supported | Supported | Partially supported | regression |
| openrouter-qwen-3-32b | row_182 | Her father (Rameshwar) wanted a son, but despite being a gir… | Not supported | Supported | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_183 | The following year, qualification was achieved for the FIFA … | Supported | Partially supported | Partially supported | improvement |
| openrouter-mistral-small-3.2 | row_186 | Combat Zone Wrestling (CZW) is an American independent profe… | Supported | Not supported | Partially supported | lateral |
| openrouter-qwen-3-32b | row_184 | It is managed as part of the Nature Reserve of Orange County… | Partially supported | Supported | Partially supported | regression |
| openrouter-granite-4.1-8b | row_186 | Combat Zone Wrestling (CZW) is an American independent profe… | PARSE_ERROR | Not supported | Partially supported | lateral |
| openrouter-gemma-4-26b-a4b | row_189 | ISBN 9781936393466. | Source unavailable | Not supported | Supported | lateral |
| openrouter-gemma-4-26b-a4b | row_187 | The summit also called upon Israel to relinquish it's occupa… | Supported | Partially supported | Partially supported | improvement |
