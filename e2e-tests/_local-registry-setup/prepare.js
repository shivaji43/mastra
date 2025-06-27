import { exec, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const defaultTimeout = 3 * 60 * 1000;

let maxRetries = 5;
function retryWithTimeout(fn, timeout, name, retryCount = 0) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Command "${name}" timed out after ${timeout}ms in ${retryCount} retries`)),
      timeout,
    );
  });

  const callbackPromise = fn();

  return Promise.race([callbackPromise, timeoutPromise]).catch(err => {
    if (retryCount < maxRetries) {
      return retryWithTimeout(fn, timeout, name, retryCount + 1);
    }

    throw err;
  });
}

function cleanup(monorepoDir, resetChanges = false) {
  execSync('git checkout .', {
    cwd: monorepoDir,
    stdio: ['inherit', 'inherit', 'pipe'],
  });
  execSync('git clean -fd', {
    cwd: monorepoDir,
    stdio: ['inherit', 'inherit', 'pipe'],
  });

  if (resetChanges) {
    execSync('git reset --soft HEAD~1', {
      cwd: monorepoDir,
      stdio: ['inherit', 'inherit', 'pipe'],
    });
  }
}

/**
 *
 * @param {string} storageDirectory
 * @param {number} port
 * @returns
 */
export async function prepareMonorepo(monorepoDir, glob) {
  let shelvedChanges = false;

  try {
    const gitStatus = await execAsync('git status --porcelain', {
      cwd: monorepoDir,
      encoding: 'utf8',
    });

    if (gitStatus.length > 0) {
      await execAsync('git add -A', {
        cwd: monorepoDir,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      await execAsync('git commit -m "SAVEPOINT"', {
        cwd: monorepoDir,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      shelvedChanges = true;
    }

    await (async function updateWorkspaceDependencies() {
      // Update workspace dependencies to use ^ instead of *
      const packageFiles = await glob('**/package.json', {
        ignore: ['**/node_modules/**', '**/examples/**'],
        cwd: monorepoDir,
      });

      for (const file of packageFiles) {
        const content = readFileSync(join(monorepoDir, file), 'utf8');

        const parsed = JSON.parse(content);
        if (parsed?.peerDependencies?.['@mastra/core']) {
          parsed.peerDependencies['@mastra/core'] = 'workspace:*';
        }

        writeFileSync(join(monorepoDir, file), JSON.stringify(parsed, null, 2));
      }
    })();

    await retryWithTimeout(
      async () => {
        await execAsync('pnpm changeset pre exit', {
          cwd: monorepoDir,
          stdio: ['inherit', 'inherit', 'inherit'],
        });
      },
      defaultTimeout,
      'pnpm changeset pre exit',
    );

    await retryWithTimeout(
      async () => {
        await execAsync('pnpm changeset version --snapshot create-mastra-e2e-test', {
          cwd: monorepoDir,
          stdio: ['inherit', 'inherit', 'inherit'],
        });
      },
      defaultTimeout,
      'pnpm changeset version --snapshot create-mastra-e2e-test',
    );
  } catch (error) {
    cleanup(monorepoDir, false);
    throw error;
  }

  return () => cleanup(monorepoDir, shelvedChanges);
}
