export class TokenBudget {
  private budget: number;
  private used = 0;
  private safetyMargin: number;

  constructor(maxTokens: number, safetyMargin = 0.25) {
    this.budget = Math.floor(maxTokens * (1 - safetyMargin));
    this.safetyMargin = safetyMargin;
  }

  tryAllocate(text: string): boolean {
    const tokens = this.countTokens(text);
    if (this.used + tokens > this.budget) return false;
    this.used += tokens;
    return true;
  }

  remaining(): number {
    return Math.max(0, this.budget - this.used);
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
