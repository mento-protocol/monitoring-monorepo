import { AsyncSemaphore } from './async-semaphore';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('AsyncSemaphore', () => {
  it('rejects invalid limits', () => {
    expect(() => new AsyncSemaphore(0)).toThrow(
      'Semaphore limit must be a positive integer',
    );
    expect(() => new AsyncSemaphore(1.5)).toThrow(
      'Semaphore limit must be a positive integer',
    );
  });

  it('starts at most the configured number of tasks', async () => {
    const semaphore = new AsyncSemaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    let markThirdStarted!: () => void;
    const thirdStarted = new Promise<void>((resolve) => {
      markThirdStarted = resolve;
    });

    const tasks = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        if (index === 2) {
          markThirdStarted();
        }
        await gate.promise;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[0]?.resolve();
    await thirdStarted;
    expect(started).toEqual([0, 1, 2]);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(tasks);
  });

  it('releases a slot after a task rejects', async () => {
    const semaphore = new AsyncSemaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');

    await expect(semaphore.run(async () => 'next')).resolves.toBe('next');
  });
});
