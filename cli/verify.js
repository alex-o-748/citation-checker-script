// Entry point for the `ccs` CLI. Later phases add argv parsing, Wikipedia
// fetch, and the verification pipeline. For now this is a placeholder so
// `bin/ccs` can import something.

export async function main(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        process.stdout.write('usage: ccs verify <wikipedia-url> <citation-number> [--provider <name>] [--no-log]\n');
        return 0;
    }
    process.stderr.write(`ccs: not yet implemented (received: ${args.join(' ')})\n`);
    return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then((code) => process.exit(code));
}
