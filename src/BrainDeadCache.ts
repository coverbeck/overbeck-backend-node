const cacheTtlSeconds: number = 20 * 60;
export class BrainDeadCache {
  private time: number;
  private value: any;
  constructor(private ttlSeconds = cacheTtlSeconds) {
  }
  public getData(): any {
    return this.value && (Date.now() - (this.ttlSeconds * 1000)) < this.time && this.value;
  }
  public setData(value: any) {
    this.time = Date.now();
    this.value = value;
  }
}
