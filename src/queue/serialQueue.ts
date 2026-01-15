import PQueue from "p-queue";

export class SerialQueue {
  private readonly queue: PQueue;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.queue = new PQueue({ concurrency: 1 });
    this.maxSize = maxSize;
  }

  get pending(): number {
    return this.queue.size;
  }

  get running(): number {
    return this.queue.pending;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.size >= this.maxSize) {
      const error = new Error("Queue is full");
      (error as unknown as { code: string }).code = "QUEUE_FULL";
      throw error;
    }
    return this.queue.add(task);
  }
}

