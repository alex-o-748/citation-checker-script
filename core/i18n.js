// User-interface localization for the Wikipedia citation-verifier userscript.
// The userscript detects the reader's MediaWiki interface language
// (mw.config.get('wgUserLanguage')) and renders its sidebar, report view,
// dialogs and exported reports in that language when a translation exists,
// otherwise falling back to English.
//
// This module is pure (no DOM / no mw.* access) so it can be unit-tested and
// is inlined into main.js by scripts/sync-main.js like the other core/ modules.
//
// Message values are either plain strings with {placeholder} tokens or
// functions (params) => string. Functions carry the plural / composition
// logic that differs between languages (English pluralizes with a trailing
// "s"; Hebrew uses distinct singular/plural word forms).

// BCP-47 / MediaWiki language codes that render right-to-left. Only the ones
// this script is likely to encounter are listed; extend as translations are
// added. isRtlLang() also treats regional variants ("he-x-...", "ar-eg") as
// RTL by matching on the primary subtag.
export const RTL_LANGS = Object.freeze([
    'he', 'ar', 'fa', 'ur', 'yi', 'arc', 'dv', 'ckb', 'ps', 'sd', 'ug', 'arz',
]);

export function isRtlLang(lang) {
    if (!lang) return false;
    const primary = String(lang).toLowerCase().split('-')[0];
    return RTL_LANGS.includes(primary);
}

// English is always the fallback; every other entry in MESSAGES is a
// supported UI language. resolveUiLang maps an arbitrary MediaWiki language
// code onto a supported catalog key (primary subtag, then 'en').
export function resolveUiLang(lang) {
    if (!lang) return 'en';
    const raw = String(lang).toLowerCase();
    if (MESSAGES[raw]) return raw;
    const primary = raw.split('-')[0];
    if (MESSAGES[primary]) return primary;
    return 'en';
}

export const MESSAGES = {
    en: {
        // Header / chrome
        appTitle: 'Source Verifier',
        close: 'Close',

        // Claim + source sections
        selectedClaim: 'Selected Claim',
        claimPlaceholder: 'Click on a reference number [1] next to a claim to verify it against its source.',
        sourceContent: 'Source Content',
        noSourceLoaded: 'No source loaded yet.',
        verificationResult: 'Verification Result',

        // Buttons
        setApiKey: 'Set API Key',
        verifyClaim: 'Verify Claim',
        verifying: 'Verifying...',
        changeKey: 'Change Key',
        removeApiKey: 'Remove API Key',
        loadText: 'Load Text',
        cancel: 'Cancel',
        save: 'Save',
        pasteSourceManually: 'Paste source text manually',
        pasteSourceManuallyTitle: 'Replace the fetched source content with text you paste in (e.g., the full article from The Wikipedia Library)',
        verifyAll: 'Verify All Citations',
        stop: 'Stop',
        backToReport: 'Back to Report',
        editSection: 'Edit Section',
        giveFeedback: 'Give feedback',
        sourcePlaceholder: 'Paste the source text here...',

        // Provider info line
        usingYourKey: '✓ Using your {provider} API key',
        freeOptionalPrefix: '✓ Free to use. Optional: ',
        addYourKey: 'add your {provider} API key',
        freeToUse: '✓ Free to use',
        keyConfigured: 'API key configured for {provider}',
        keyRequired: 'API key required for {provider}',
        privacyNote: 'Results are logged for research. Your username is not recorded.',

        // Portlet tab + first-run notification
        verifyTab: 'Verify',
        verifyTabTooltip: 'Verify claims against sources',
        firstRunTitle: 'Citation Verifier',
        firstRunPre: 'Citation Verifier installed — click the ',
        firstRunPost: ' tab to get started.',

        // Source fetch status
        sourceUrlLabel: 'Source URL:',
        pdfExtractedWithPage: '✓ PDF content extracted (page {page} of {total})',
        pdfExtractedPages: '✓ PDF content extracted ({total} pages)',
        contentFetched: '✓ Content fetched successfully',
        contentWillBeFetched: 'Content will be fetched by AI during verification.',
        sourceTruncatedWarning: '⚠ The source is long and can only be checked partially.',
        noUrlPasteBelow: 'No URL found. Please paste the source text below:',
        manualSourceLabel: 'Manual Source Text:',

        // Set / remove API key dialog
        setKeyDialogTitle: 'Set {provider} API Key',
        setKeyDialogMessage: 'Enter your {provider} API Key to enable source verification:',
        setKeyPlaceholder: 'Enter your {provider} API Key...',
        removeKeyConfirm: 'Are you sure you want to remove the stored API key?',

        // Single-result view
        clickVerifyToStart: 'Click "Verify Claim" to verify the selected claim against the source.',
        errorLabel: 'ERROR',

        // Verdict labels — full form shown in the single-result box
        verdictFull_supported: 'SUPPORTED',
        verdictFull_partial: 'PARTIALLY SUPPORTED',
        verdictFull_notSupported: 'NOT SUPPORTED',
        verdictFull_unavailable: 'SOURCE UNAVAILABLE',
        // Verdict labels — short form shown in report cards / chips
        verdictShort_supported: 'Supported',
        verdictShort_partial: 'Partial',
        verdictShort_notSupported: 'Not Supported',
        verdictShort_unavailable: 'Unavailable',
        // Reason-type tags
        reasonContradiction: 'Contradiction',
        reasonOmission: 'Omission',

        // Report filters + summary
        filterEmpty: 'All citations are hidden by the current filters. Click a filter chip above to show them.',
        filterChipTitleShow: 'Show {label} citations',
        filterChipTitleHide: 'Hide {label} citations',
        chipLabel_supported: 'supported',
        chipLabel_partial: 'partial',
        chipLabel_notSupported: 'not supported',
        chipLabel_unavailable: 'unavailable',
        chipLabel_error: 'errors',
        summaryCitationsChecked: (p) => `${p.count} citation${p.count === 1 ? '' : 's'} checked`,
        summaryAcross: (p) => `${p.citations} citations across ${p.claims} claim${p.claims === 1 ? '' : 's'}`,
        hiddenByFilter: '{n} hidden by filter',
        tokensUsageMeta: '{input} input + {output} output tokens',
        revisionLabel: 'Revision:',

        // Report cards / groups
        truncatedSolo: '⚠ Source is long, only partially checked.',
        truncatedCombined: '⚠ Combined sources are long, only partially checked.',
        groupBadge: 'Group of {size} · {numbers}',
        checkingCombined: 'Checking combined sources…',
        individualSources: 'Individual sources',
        combinedVerdict: 'Combined verdict',
        partOfGroup: 'Part of a group of {count} citations: {numbers}',

        // Report actions + clipboard
        copyWikitext: 'Copy Report (Wikitext)',
        copyPlaintext: 'Copy Report (Plain Text)',
        reportCopied: 'Report copied to clipboard!',

        // Progress phases
        phaseChecking: 'Checking citation [{n}]',
        phaseFetching: 'Fetching source for [{n}]',
        phaseVerifying: 'Verifying citation [{n}]',
        phaseRateLimited: 'Rate limited, retrying in {s}s...',
        phaseCheckingCombined: 'Checking combined sources {numbers}',
        phaseCancelled: 'Cancelled after {done} of {total} citations',
        phaseCompleted: 'Completed: {n} citations checked',
        etaRemaining: '~{time} remaining',
        durationSeconds: '{s}s',
        durationMinutes: '{m}m {s}s',

        // Verify-all confirmation
        noCitationsFound: 'No citations found on this page.',
        confirmVerifyAll: (p) => {
            const groupNote = p.groups > 0
                ? `\n\nThis includes ${p.groups} combined-source check${p.groups === 1 ? '' : 's'} for adjacent citation groups.`
                : '';
            return `This will verify ${p.count} citations from ${p.sources} unique sources.${groupNote}\n\nEstimated time: ~${p.minutes} minute${p.minutes > 1 ? 's' : ''}.\n\nContinue?`;
        },

        // Edit summary written to the wiki
        editSummary: 'source does not support claim (checked with [[User:Alaexis/AI_Source_Verification|Source Verifier]])',

        // Wikitext report
        wt_reportHeading: 'Citation verification report',
        wt_intro: 'This is an experimental check of the article sources by [[User:Alaexis/AI_Source_Verification|Citation Verifier]]. Treat it with caution, be aware of its [[User:Alaexis/AI_Source_Verification#Limitations|limitations]] and feel free to leave feedback at [[User_talk:Alaexis/AI_Source_Verification|the talk page]].',
        wt_revisionChecked: 'Revision checked: [[Special:PermanentLink/{revId}|{revId}]]',
        wt_colHeadersWithSubmit: '! # !! Verdict !! Source !! Comments !! class="unsortable" | Submit',
        wt_colHeaders: '! # !! Verdict !! Source !! Comments',
        wt_verdictSupported: '{{tick}} Supported',
        wt_verdictPartial: '{{bang}} Partially supported',
        wt_verdictNotSupported: '{{cross}} Not supported',
        wt_verdictUnavailable: '{{hmmm}} Source unavailable',
        wt_combined: '(combined)',
        wt_sourceWord: 'source',
        wt_submitWord: 'Submit',
        wt_noteCombined: "''(Combined sources are long, only partially checked.)''",
        wt_noteSolo: "''(Source is long, only partially checked.)''",
        wt_summary: (p) => `'''Summary:''' ${p.supported} supported, ${p.partial} partially supported, ${p.notSupported} not supported, ${p.unavailable} source unavailable out of ${p.claimsPhrase}.`,
        wt_claimsPhraseCitations: (p) => `${p.count} citation${p.count === 1 ? '' : 's'}`,
        wt_claimsPhraseClaims: (p) => `${p.claims} claim${p.claims === 1 ? '' : 's'} (${p.citations} citations)`,
        wt_generatedBy: 'Generated by [[User:Alaexis/AI_Source_Verification|Citation Verifier]] using {model} on ~~~~~.',
        wt_tokensUsed: ' Tokens used: {input} input, {output} output.',
        wt_modelPublicai: 'a PublicAI-hosted open-source LLM',
        wt_modelHuggingface: 'a HuggingFace-hosted open-source LLM ({model})',

        // Plain-text report
        pt_title: 'Citation Verification Report: {title}',
        pt_provider: 'Provider: {name}',
        pt_revision: 'Revision: {rev}',
        pt_combined: '(combined)',
        pt_claim: 'Claim:',
        pt_sources: 'Sources:',
        pt_source: 'Source:',
        pt_comments: 'Comments:',
        pt_noteLabel: 'Note:',
        pt_noteCombined: 'Combined sources are long, only partially checked.',
        pt_noteSolo: 'Source is long, only partially checked.',
        pt_tokensUsed: 'Tokens used: {input} input, {output} output',
    },

    he: {
        // Header / chrome
        appTitle: 'מאמת מקורות',
        close: 'סגור',

        // Claim + source sections
        selectedClaim: 'טענה שנבחרה',
        claimPlaceholder: 'לחצו על מספר הפניה [1] שליד טענה כדי לאמת אותה מול המקור שלה.',
        sourceContent: 'תוכן המקור',
        noSourceLoaded: 'לא נטען מקור עדיין.',
        verificationResult: 'תוצאת האימות',

        // Buttons
        setApiKey: 'הגדרת מפתח API',
        verifyClaim: 'אימות טענה',
        verifying: 'מאמת...',
        changeKey: 'שינוי מפתח',
        removeApiKey: 'הסרת מפתח API',
        loadText: 'טעינת טקסט',
        cancel: 'ביטול',
        save: 'שמירה',
        pasteSourceManually: 'הדבקת טקסט המקור ידנית',
        pasteSourceManuallyTitle: 'החלפת תוכן המקור שנטען בטקסט שתדביקו (למשל המאמר המלא מספריית ויקיפדיה)',
        verifyAll: 'אימות כל הציטוטים',
        stop: 'עצירה',
        backToReport: 'חזרה לדוח',
        editSection: 'עריכת מקטע',
        giveFeedback: 'משוב',
        sourcePlaceholder: 'הדביקו כאן את טקסט המקור...',

        // Provider info line
        usingYourKey: '✓ נעשה שימוש במפתח ה-API שלכם של {provider}',
        freeOptionalPrefix: '✓ חינמי לשימוש. אופציונלי: ',
        addYourKey: 'הוספת מפתח API של {provider}',
        freeToUse: '✓ חינמי לשימוש',
        keyConfigured: 'מפתח API הוגדר עבור {provider}',
        keyRequired: 'נדרש מפתח API עבור {provider}',
        privacyNote: 'התוצאות נרשמות לצורכי מחקר. שם המשתמש שלכם אינו נשמר.',

        // Portlet tab + first-run notification
        verifyTab: 'אימות',
        verifyTabTooltip: 'אימות טענות מול מקורות',
        firstRunTitle: 'מאמת הציטוטים',
        firstRunPre: 'מאמת הציטוטים הותקן — לחצו על הכרטיסייה ',
        firstRunPost: ' כדי להתחיל.',

        // Source fetch status
        sourceUrlLabel: 'כתובת המקור:',
        pdfExtractedWithPage: '✓ תוכן ה-PDF חולץ (עמוד {page} מתוך {total})',
        pdfExtractedPages: '✓ תוכן ה-PDF חולץ ({total} עמודים)',
        contentFetched: '✓ התוכן נטען בהצלחה',
        contentWillBeFetched: 'התוכן ייטען על ידי הבינה המלאכותית במהלך האימות.',
        sourceTruncatedWarning: '⚠ המקור ארוך וניתן לבדוק אותו רק באופן חלקי.',
        noUrlPasteBelow: 'לא נמצאה כתובת. הדביקו את טקסט המקור למטה:',
        manualSourceLabel: 'טקסט מקור ידני:',

        // Set / remove API key dialog
        setKeyDialogTitle: 'הגדרת מפתח API של {provider}',
        setKeyDialogMessage: 'הזינו את מפתח ה-API של {provider} כדי לאפשר אימות מקורות:',
        setKeyPlaceholder: 'הזינו את מפתח ה-API של {provider}...',
        removeKeyConfirm: 'האם אתם בטוחים שברצונכם להסיר את מפתח ה-API השמור?',

        // Single-result view
        clickVerifyToStart: 'לחצו על "אימות טענה" כדי לאמת את הטענה שנבחרה מול המקור.',
        errorLabel: 'שגיאה',

        // Verdict labels — full form
        verdictFull_supported: 'נתמך',
        verdictFull_partial: 'נתמך חלקית',
        verdictFull_notSupported: 'לא נתמך',
        verdictFull_unavailable: 'המקור אינו זמין',
        // Verdict labels — short form
        verdictShort_supported: 'נתמך',
        verdictShort_partial: 'חלקי',
        verdictShort_notSupported: 'לא נתמך',
        verdictShort_unavailable: 'לא זמין',
        // Reason-type tags
        reasonContradiction: 'סתירה',
        reasonOmission: 'השמטה',

        // Report filters + summary
        filterEmpty: 'כל הציטוטים מוסתרים על ידי המסננים הנוכחיים. לחצו על תווית סינון למעלה כדי להציגם.',
        filterChipTitleShow: 'הצגת ציטוטים במצב {label}',
        filterChipTitleHide: 'הסתרת ציטוטים במצב {label}',
        chipLabel_supported: 'נתמך',
        chipLabel_partial: 'חלקי',
        chipLabel_notSupported: 'לא נתמך',
        chipLabel_unavailable: 'לא זמין',
        chipLabel_error: 'שגיאות',
        summaryCitationsChecked: (p) => p.count === 1
            ? 'ציטוט אחד נבדק'
            : `${p.count} ציטוטים נבדקו`,
        summaryAcross: (p) => `${p.citations} ציטוטים ב-${p.claims} ${p.claims === 1 ? 'טענה' : 'טענות'}`,
        hiddenByFilter: '{n} מוסתרים על ידי מסנן',
        tokensUsageMeta: '{input} קלט + {output} פלט אסימונים',
        revisionLabel: 'גרסה:',

        // Report cards / groups
        truncatedSolo: '⚠ המקור ארוך, נבדק רק באופן חלקי.',
        truncatedCombined: '⚠ המקורות המשולבים ארוכים, נבדקו רק באופן חלקי.',
        groupBadge: 'קבוצה של {size} · {numbers}',
        checkingCombined: 'בודק מקורות משולבים…',
        individualSources: 'מקורות בודדים',
        combinedVerdict: 'פסק משולב',
        partOfGroup: 'חלק מקבוצה של {count} ציטוטים: {numbers}',

        // Report actions + clipboard
        copyWikitext: 'העתקת דוח (קוד ויקי)',
        copyPlaintext: 'העתקת דוח (טקסט רגיל)',
        reportCopied: 'הדוח הועתק ללוח!',

        // Progress phases
        phaseChecking: 'בודק ציטוט [{n}]',
        phaseFetching: 'טוען מקור עבור [{n}]',
        phaseVerifying: 'מאמת ציטוט [{n}]',
        phaseRateLimited: 'הוגבל קצב, מנסה שוב בעוד {s} שניות...',
        phaseCheckingCombined: 'בודק מקורות משולבים {numbers}',
        phaseCancelled: 'בוטל לאחר {done} מתוך {total} ציטוטים',
        phaseCompleted: 'הושלם: {n} ציטוטים נבדקו',
        etaRemaining: 'נותרו כ-{time}',
        durationSeconds: '{s} שנ׳',
        durationMinutes: '{m} דק׳ {s} שנ׳',

        // Verify-all confirmation
        noCitationsFound: 'לא נמצאו ציטוטים בדף זה.',
        confirmVerifyAll: (p) => {
            const groupNote = p.groups > 0
                ? `\n\nזה כולל ${p.groups} בדיקות של מקורות משולבים עבור קבוצות ציטוטים סמוכות.`
                : '';
            return `פעולה זו תאמת ${p.count} ציטוטים מ-${p.sources} מקורות ייחודיים.${groupNote}\n\nזמן משוער: כ-${p.minutes} דקות.\n\nלהמשיך?`;
        },

        // Edit summary written to the wiki
        editSummary: 'המקור אינו תומך בטענה (נבדק באמצעות [[User:Alaexis/AI_Source_Verification|מאמת המקורות]])',

        // Wikitext report
        wt_reportHeading: 'דוח אימות ציטוטים',
        wt_intro: 'זוהי בדיקה ניסיונית של מקורות הערך באמצעות [[User:Alaexis/AI_Source_Verification|מאמת הציטוטים]]. יש להתייחס אליה בזהירות, להכיר את [[User:Alaexis/AI_Source_Verification#Limitations|מגבלותיה]] ולהשאיר משוב ב[[User_talk:Alaexis/AI_Source_Verification|דף השיחה]].',
        wt_revisionChecked: 'הגרסה שנבדקה: [[Special:PermanentLink/{revId}|{revId}]]',
        wt_colHeadersWithSubmit: '! # !! פסק !! מקור !! הערות !! class="unsortable" | שליחה',
        wt_colHeaders: '! # !! פסק !! מקור !! הערות',
        wt_verdictSupported: '{{tick}} נתמך',
        wt_verdictPartial: '{{bang}} נתמך חלקית',
        wt_verdictNotSupported: '{{cross}} לא נתמך',
        wt_verdictUnavailable: '{{hmmm}} המקור אינו זמין',
        wt_combined: '(משולב)',
        wt_sourceWord: 'מקור',
        wt_submitWord: 'שליחה',
        wt_noteCombined: "''(המקורות המשולבים ארוכים, נבדקו רק באופן חלקי.)''",
        wt_noteSolo: "''(המקור ארוך, נבדק רק באופן חלקי.)''",
        wt_summary: (p) => `'''סיכום:''' ${p.supported} נתמכו, ${p.partial} נתמכו חלקית, ${p.notSupported} לא נתמכו, ${p.unavailable} המקור אינו זמין מתוך ${p.claimsPhrase}.`,
        wt_claimsPhraseCitations: (p) => `${p.count} ציטוטים`,
        wt_claimsPhraseClaims: (p) => `${p.claims} ${p.claims === 1 ? 'טענה' : 'טענות'} (${p.citations} ציטוטים)`,
        wt_generatedBy: 'נוצר באמצעות [[User:Alaexis/AI_Source_Verification|מאמת הציטוטים]] באמצעות {model} ב-~~~~~.',
        wt_tokensUsed: ' אסימונים שנוצלו: {input} קלט, {output} פלט.',
        wt_modelPublicai: 'מודל שפה בקוד פתוח המאוחסן ב-PublicAI',
        wt_modelHuggingface: 'מודל שפה בקוד פתוח המאוחסן ב-HuggingFace ({model})',

        // Plain-text report
        pt_title: 'דוח אימות ציטוטים: {title}',
        pt_provider: 'ספק: {name}',
        pt_revision: 'גרסה: {rev}',
        pt_combined: '(משולב)',
        pt_claim: 'טענה:',
        pt_sources: 'מקורות:',
        pt_source: 'מקור:',
        pt_comments: 'הערות:',
        pt_noteLabel: 'הערה:',
        pt_noteCombined: 'המקורות המשולבים ארוכים, נבדקו רק באופן חלקי.',
        pt_noteSolo: 'המקור ארוך, נבדק רק באופן חלקי.',
        pt_tokensUsed: 'אסימונים שנוצלו: {input} קלט, {output} פלט',
    },
};

// Build a translator bound to a resolved UI language. The returned msg(key,
// params) looks up the key in the target language, falls back to English,
// then to the key itself. String values interpolate {name} tokens from
// params; function values are called with params (used for plurals and
// multi-part composition).
export function createTranslator(lang) {
    const resolved = resolveUiLang(lang);
    const table = MESSAGES[resolved];
    const fallback = MESSAGES.en;

    return function msg(key, params) {
        let entry = table[key];
        if (entry === undefined) entry = fallback[key];
        if (entry === undefined) return key;
        if (typeof entry === 'function') return entry(params || {});
        if (!params) return entry;
        return entry.replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        );
    };
}
