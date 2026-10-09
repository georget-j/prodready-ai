import type { ChallengeRunnerConfig } from "@/lib/featured-files";

export type DemoLesson = {
  slug: string;
  track: string;
  title: string;
  description: string;
  goal: string;
  hints: string[];
  solution: Record<string, string>;
  config: Extract<ChallengeRunnerConfig, { mode: "pyodide" }>;
};

// Self-contained, fictional exercises. Demo routes never load account data
// or call the authenticated mentor/submission API.
export const DEMO_LESSONS: DemoLesson[] = [
  {
    slug: "basket-total",
    track: "Python foundations",
    title: "Fix the basket total",
    description: "A small shop's checkout ignores quantities. Find the bug before an order goes out with the wrong total.",
    goal: "Return the sum of price × quantity for every item. An empty basket should cost zero.",
    hints: [
      "If a customer buys three notebooks, should checkout charge for one or three? Which part of each item is being ignored?",
      "Look inside basket_total in basket.py. The loop reads price, but does it ever read quantity?",
      "For each item, multiply price by quantity, add that amount to total, then return total after the loop.",
    ],
    solution: { "basket.py": "def basket_total(items):\n    return sum(item['price'] * item['quantity'] for item in items)\n" },
    config: {
      mode: "pyodide", editable: ["basket.py"], readonly: ["test_basket.py"],
      tests: [
        { id: "test_basket.py::test_quantities", description: "Charge for every unit, not just one of each item." },
        { id: "test_basket.py::test_empty", description: "An empty basket has a total of zero." },
        { id: "test_basket.py::test_decimal_prices", description: "Handle prices with decimal places." },
      ],
      inline: {
        "basket.py": "def basket_total(items):\n    total = 0\n    for item in items:\n        total += item['price']  # Something is missing here.\n    return total\n",
        "test_basket.py": "import pytest\nfrom basket import basket_total\n\ndef test_quantities():\n    assert basket_total([{'price': 12, 'quantity': 3}, {'price': 5, 'quantity': 2}]) == 46\n\ndef test_empty():\n    assert basket_total([]) == 0\n\ndef test_decimal_prices():\n    assert basket_total([{'price': 2.50, 'quantity': 3}]) == pytest.approx(7.50)\n",
      },
    },
  },
  {
    slug: "validate-order",
    track: "Backend production",
    title: "Guard the order boundary",
    description: "An order handler accepts zero, negative and fractional quantities. Repair the validation before bad requests reach the business logic.",
    goal: "Accept positive integer quantities only. Reject all other values with ValueError, including booleans.",
    hints: [
      "What happens if quantity is zero or 1.5? What does a valid count of items look like?",
      "Inspect validate_quantity in orders.py. In Python, bool is a subclass of int; how can you require an actual integer?",
      "Reject the value when type(quantity) is not int OR quantity is less than 1. Otherwise return it unchanged.",
    ],
    solution: { "orders.py": "def validate_quantity(quantity):\n    if type(quantity) is not int or quantity < 1:\n        raise ValueError('Quantity must be a positive integer')\n    return quantity\n" },
    config: {
      mode: "pyodide", editable: ["orders.py"], readonly: ["test_orders.py"],
      tests: [
        { id: "test_orders.py::test_valid", description: "Accept a positive integer quantity." },
        { id: "test_orders.py::test_nonpositive", description: "Reject zero and negative quantities." },
        { id: "test_orders.py::test_types", description: "Reject decimals, strings and booleans." },
      ],
      inline: {
        "orders.py": "def validate_quantity(quantity):\n    # TODO: reject invalid quantities before accepting this order.\n    return quantity\n",
        "test_orders.py": "import pytest\nfrom orders import validate_quantity\n\ndef test_valid():\n    assert validate_quantity(3) == 3\n\ndef test_nonpositive():\n    for value in [0, -2]:\n        with pytest.raises(ValueError):\n            validate_quantity(value)\n\ndef test_types():\n    for value in [1.5, '3', True, None]:\n        with pytest.raises(ValueError):\n            validate_quantity(value)\n",
      },
    },
  },
  {
    slug: "simple-returns",
    track: "Quant programmer",
    title: "Calculate returns correctly",
    description: "A price series is showing cash changes as percentage returns. Fix the calculation so different price levels can be compared.",
    goal: "Calculate (current − previous) / previous for each adjacent pair. Fewer than two prices should return an empty list.",
    hints: [
      "A move from 100 to 110 is +10%. Does a move from 200 to 210 have the same percentage return?",
      "Look at simple_returns in returns.py. The difference is correct, but what should it be divided by?",
      "For each index from 1 onward, subtract the previous price from the current one and divide by the previous price. Collect each result in a list.",
    ],
    solution: { "returns.py": "def simple_returns(prices):\n    return [(prices[i] - prices[i - 1]) / prices[i - 1] for i in range(1, len(prices))]\n" },
    config: {
      mode: "pyodide", editable: ["returns.py"], readonly: ["test_returns.py"],
      tests: [
        { id: "test_returns.py::test_gain", description: "A move from 100 to 110 returns 0.10." },
        { id: "test_returns.py::test_loss_and_flat", description: "Handle falling and unchanged prices." },
        { id: "test_returns.py::test_short_series", description: "Empty and one-price series contain no returns." },
      ],
      inline: {
        "returns.py": "def simple_returns(prices):\n    return [prices[i] - prices[i - 1] for i in range(1, len(prices))]\n",
        "test_returns.py": "import pytest\nfrom returns import simple_returns\n\ndef test_gain():\n    assert simple_returns([100, 110]) == pytest.approx([0.10])\n\ndef test_loss_and_flat():\n    assert simple_returns([200, 180, 180]) == pytest.approx([-0.10, 0.0])\n\ndef test_short_series():\n    assert simple_returns([]) == []\n    assert simple_returns([100]) == []\n",
      },
    },
  },
];

export const DEMO_PROGRESS_KEY = "prodready:demo:progress:v1";
