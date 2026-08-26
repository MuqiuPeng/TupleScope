/**
 * Exact decimal arithmetic over scaled BigInt.
 *
 * Small on purpose — the only operations the assertion language needs are
 * add, subtract, compare and negate. What it must never do is round-trip
 * through a JS number, which is why there is no `toNumber()` here at all:
 *
 *   0.1 + 0.2 === 0.30000000000000004
 *   Number("9007199254740993") === 9007199254740992
 *
 * A tool whose headline example is a ledger cannot afford either.
 */

export class Decimal {
  /** Unscaled value: the digits with the point removed. */
  private readonly units: bigint;
  /** Number of digits after the point. */
  private readonly scale: number;

  private constructor(units: bigint, scale: number) {
    this.units = units;
    this.scale = scale;
  }

  static parse(text: string): Decimal {
    const trimmed = text.trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`not a decimal: ${text}`);
    }
    const negative = trimmed.startsWith('-');
    const digits = trimmed.replace(/^[+-]/, '');
    const dot = digits.indexOf('.');
    const scale = dot === -1 ? 0 : digits.length - dot - 1;
    const units = BigInt(digits.replace('.', ''));
    return new Decimal(negative ? -units : units, scale);
  }

  static isDecimal(text: string): boolean {
    return /^[+-]?\d+(\.\d+)?$/.test(text.trim());
  }

  static zero(): Decimal {
    return new Decimal(0n, 0);
  }

  /** Re-expresses both operands at the finer of the two scales. */
  private static align(a: Decimal, b: Decimal): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    const lift = (d: Decimal) => d.units * 10n ** BigInt(scale - d.scale);
    return [lift(a), lift(b), scale];
  }

  plus(other: Decimal): Decimal {
    const [x, y, scale] = Decimal.align(this, other);
    return new Decimal(x + y, scale);
  }

  minus(other: Decimal): Decimal {
    const [x, y, scale] = Decimal.align(this, other);
    return new Decimal(x - y, scale);
  }

  negated(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  /** -1, 0 or 1. Compares by value, so `1.10` equals `1.1`. */
  compare(other: Decimal): -1 | 0 | 1 {
    const [x, y] = Decimal.align(this, other);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const frac = this.scale === 0 ? '' : `.${digits.slice(digits.length - this.scale)}`;
    return `${negative ? '-' : ''}${whole}${frac}`;
  }
}
