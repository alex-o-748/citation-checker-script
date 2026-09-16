import {
    MAX_BODY_BYTES,
    MAX_CLAIM_CHARS,
    MAX_SOURCE_CONTENT_CHARS,
} from './verify.js';

export const OPENAPI_DOCUMENT = Object.freeze({
    openapi: '3.1.0',
    info: {
        title: 'Citation Verifier API',
        version: '1.0.0',
        description: 'Verify one claim against one cited source using the Source Verifier pipeline.',
    },
    paths: {
        '/v1/verify': {
            post: {
                summary: 'Verify one claim against one source',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['claim'],
                                anyOf: [
                                    { required: ['source_url'] },
                                    { required: ['source_content'] },
                                ],
                                properties: {
                                    claim: { type: 'string', minLength: 1, maxLength: MAX_CLAIM_CHARS },
                                    source_url: { type: 'string', format: 'uri', pattern: '^https?://' },
                                    source_content: { type: 'string', minLength: 1, maxLength: MAX_SOURCE_CONTENT_CHARS },
                                    page: { type: 'integer', minimum: 1 },
                                },
                                additionalProperties: false,
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Verification result',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/VerifyResult' } } },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    413: { description: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
                    415: { description: 'Content-Type is not application/json' },
                    422: { description: 'Source unavailable' },
                    429: { description: 'Rate limit exceeded' },
                    502: { description: 'Verification provider or parser failure' },
                },
            },
        },
    },
    components: {
        schemas: {
            VerifyResult: {
                type: 'object',
                required: ['verdict', 'support_score', 'comments', 'reason_type', 'source_quote', 'quote_status', 'verified_text'],
                properties: {
                    verdict: { type: 'string', enum: ['SUPPORTED', 'PARTIALLY SUPPORTED', 'NOT SUPPORTED', 'SOURCE UNAVAILABLE'] },
                    support_score: { type: ['number', 'null'], minimum: 0, maximum: 100 },
                    comments: { type: 'string' },
                    reason_type: { type: ['string', 'null'] },
                    source_quote: { type: 'string' },
                    quote_status: { type: 'string' },
                    verified_text: { type: 'string' },
                },
            },
            Error: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' }, stage: { type: 'string' } },
            },
        },
        responses: {
            BadRequest: {
                description: 'Invalid request',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
        },
    },
});
