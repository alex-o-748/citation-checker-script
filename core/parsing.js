// Parses raw LLM response text into a structured verdict object.

export function parseVerificationResult(response) {
    try {
        let jsonStr = response.trim();

        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        }

        if (!codeBlockMatch) {
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                jsonStr = jsonMatch[0];
            }
        }

        const result = JSON.parse(jsonStr);
        return {
            verdict: result.verdict || 'UNKNOWN',
            confidence: result.confidence ?? null,
            comments: result.comments || ''
        };
    } catch (e) {
        return { verdict: 'ERROR', confidence: null, comments: `Failed to parse AI response: ${response.substring(0, 200)}` };
    }
}
