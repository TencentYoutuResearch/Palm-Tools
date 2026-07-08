import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli/main.js';
function capture() {
    let stdout = '';
    let stderr = '';
    return {
        io: {
            stdout: (text) => {
 stdout += text; 
},
            stderr: (text) => {
 stderr += text; 
},
        },
        stdout: () => stdout,
        stderr: () => stderr,
    };
}
describe('runCli', () => {
    test('prints help', async () => {
        const output = capture();
        expect(await runCli(['--help'], output.io)).toBe(0);
        expect(output.stdout()).toContain('specops <command>');
        expect(output.stderr()).toBe('');
    });
    test('prints version', async () => {
        const output = capture();
        expect(await runCli(['--version'], output.io)).toBe(0);
        expect(output.stdout()).toBe('0.1.0-dev\n');
    });
});
