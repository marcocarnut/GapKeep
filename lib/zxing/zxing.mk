#
# zxing-cpp's QR code reader (third_party/zxing-cpp, pinned), as GapKeep
# builds it: the sources, in core/src, and the defines. Included by
# lib/zxing/Makefile (the kernel) and sim/Makefile; read by
# tools/fuzz_qr.sh. Together with Version.h (the configuration: readers,
# QR codes only, no character set conversion) this replaces zxing-cpp's
# CMake build.
#
# Built as C++20 (zxing-cpp needs it) without exceptions or RTTI: what
# zxing-cpp would throw calls ZXing::Fatal() (src/runtime/qrdecode.cpp),
# patches/zxing-cpp/.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

ZXING_SOURCES = \
	Barcode.cpp BarcodeFormat.cpp BinaryBitmap.cpp BitMatrix.cpp BitSource.cpp \
	CharacterSet.cpp ConcentricFinder.cpp Content.cpp ECI.cpp Error.cpp \
	GlobalHistogramBinarizer.cpp GridSampler.cpp HRI.cpp HybridBinarizer.cpp \
	JSON.cpp LocalGrid.cpp MultiFormatReader.cpp PerspectiveTransform.cpp \
	ReadBarcode.cpp ReedSolomon.cpp TextDecoder.cpp Utf.cpp \
	qrcode/QRBitMatrixParser.cpp qrcode/QRCodecMode.cpp qrcode/QRDataBlock.cpp \
	qrcode/QRDecoder.cpp qrcode/QRDetector.cpp qrcode/QRErrorCorrectionLevel.cpp \
	qrcode/QRFormatInformation.cpp qrcode/QRReader.cpp qrcode/QRVersion.cpp

# ZXING_INTERNAL: as zxing-cpp's own build. One core, one thread: the
# scratch buffers zxing-cpp keeps between calls are static, not thread_local
# (Circle has no thread-local storage).
ZXING_DEFINES = -DZXING_INTERNAL -DZX_THREAD_LOCAL=static
