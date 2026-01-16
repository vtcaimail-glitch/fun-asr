import PQueue from "p-queue";

export class SerialQueue {
  private readonly queue: PQueue;

  constructor() {
    this.queue = new PQueue({ concurrency: 1 });
  }

  get pending(): number {
    return this.queue.size;
  }

  get running(): number {
    return this.queue.pending;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.add(task);
  }
}
