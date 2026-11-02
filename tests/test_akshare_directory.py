import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("directory", Path(__file__).parents[1] / "scripts" / "akshare-directory.py")
directory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(directory)


class DirectoryNormalization(unittest.TestCase):
    def test_preserves_chinese_english_and_leading_zeroes(self):
        result = directory.normalize_rows([{"symbol": "aapl", "name": "Apple Inc.", "cname": "苹果"}], "US")
        self.assertEqual(result[0]["symbol"], "US.AAPL")
        self.assertEqual(result[0]["aliases"], ["Apple Inc."])
        eastmoney = directory.normalize_rows([{"代码": "106.BRK.B", "名称": "伯克希尔"}], "US")
        self.assertEqual(eastmoney[0]["symbol"], "US.BRK.B")
        self.assertEqual(directory.normalize_rows([{"代码": "700", "中文名称": "腾讯", "英文名称": "Tencent"}], "HK")[0]["symbol"], "HK.00700")
        self.assertEqual(directory.normalize_rows([{"A股代码": "000001", "A股简称": "平安银行"}], "SZ")[0]["symbol"], "SZ.000001")

    def test_class_shares_keep_punctuation_and_names_do_not_merge_symbols(self):
        rows = [{"symbol": "BRK.B", "name": "Berkshire"}, {"symbol": "BRK.A", "name": "Berkshire"}, {"symbol": "BRK.B", "name": "Berkshire B"}]
        result = directory.normalize_rows(rows, "US")
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["symbol"], "US.BRK.B")
        self.assertEqual(result[0]["name"], "Berkshire B")

    def test_drops_null_names_and_malformed_codes_without_inventing_stocks(self):
        with self.assertRaises(ValueError):
            directory.normalize_rows([{"symbol": "NOT/A/CODE", "name": "Test"}, {"symbol": "TEST", "name": float("nan")}], "US")
        with self.assertRaises(ValueError):
            directory.normalize_rows([], "HK")


if __name__ == "__main__":
    unittest.main()
