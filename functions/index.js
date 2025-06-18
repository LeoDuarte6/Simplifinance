const functions = require("firebase-functions");
const admin = require("firebase-admin");
const authorizenet = require("authorizenet");
const { APIContracts, Constants, APIControllers } = authorizenet;

admin.initializeApp();

exports.createSubscription = functions.https.onRequest(async (req, res) => {
    try {
        functions.logger.info("--- New Request Received ---", req.body);

        if (!req.body || !req.body.email || !req.body.planPrice || !req.body.paymentDetails) {
            functions.logger.error("Request is missing required data.", req.body);
            return res.status(400).send({ error: 'Request is missing required data.' });
        }

        const { email, password, planName, planPrice, paymentDetails, name, isAdvisor } = req.body;
        functions.logger.info('Received signup data:', { email, planName, planPrice, paymentDetails });
        const { cardNumber, expiryDate, cardCode } = paymentDetails;

        if (!cardNumber || !expiryDate || !cardCode) {
            functions.logger.error("Request is missing payment details.", paymentDetails);
            return res.status(400).send({ error: 'Request is missing payment details.' });
        }

        // Try Firebase secrets first, fallback to hardcoded (remove in production)
        const apiLoginId = functions.config().authorizenet?.api_login_id || "7V4Drk4V";
        const transactionKey = functions.config().authorizenet?.transaction_key || "45Rs7ua39ADf6cAd";
        const authNetEnvironment = Constants.endpoint.sandbox; // Default to sandbox

        functions.logger.info("Authorize.Net API Login ID:", apiLoginId ? "Loaded" : "Not loaded");
        functions.logger.info("Authorize.Net Transaction Key:", transactionKey ? "Loaded" : "Not loaded");

        if (!apiLoginId || !transactionKey) {
            functions.logger.error("Authorize.Net credentials not found.");
            return res.status(500).send({ error: 'Server payment configuration error.' });
        }

        const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
        merchantAuthenticationType.setName(apiLoginId);
        merchantAuthenticationType.setTransactionKey(transactionKey);

        const paymentSchedule = new APIContracts.PaymentScheduleType();
        const interval = new APIContracts.PaymentScheduleType.Interval();
        interval.setLength(1);
        interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);
        paymentSchedule.setInterval(interval);
        paymentSchedule.setStartDate(new Date().toISOString().substring(0, 10));
        paymentSchedule.setTotalOccurrences(9999);

        const creditCard = new APIContracts.CreditCardType();
        creditCard.setCardNumber(cardNumber);

        if (typeof expiryDate !== 'string' || !expiryDate.includes('/')) {
            functions.logger.error(`Invalid expiry date format: ${expiryDate}. Use MM/YY.`);
            return res.status(400).send({ error: 'Invalid expiry date format. Use MM/YY.' });
        }
        const [month, year] = expiryDate.split('/');
        creditCard.setExpirationDate(`20${year}-${month}`);
        creditCard.setCardCode(cardCode);

        const payment = new APIContracts.PaymentType();
        payment.setCreditCard(creditCard);

        const arbSubscription = new APIContracts.ARBSubscriptionType();
        arbSubscription.setName(planName);
        arbSubscription.setPaymentSchedule(paymentSchedule);
        arbSubscription.setAmount(parseFloat(planPrice)); // Ensure planPrice is a number
        arbSubscription.setPayment(payment);

        const customer = new APIContracts.CustomerType();
        customer.setEmail(email);
        arbSubscription.setCustomer(customer);

        const createRequest = new APIContracts.ARBCreateSubscriptionRequest();
        createRequest.setMerchantAuthentication(merchantAuthenticationType);
        createRequest.setSubscription(arbSubscription);

        const ctrl = new APIControllers.ARBCreateSubscriptionController(createRequest.getJSON());
        ctrl.setEnvironment(authNetEnvironment);

        functions.logger.info('Attempting to execute Authorize.Net transaction...');

        ctrl.execute(async () => {
            const apiResponse = ctrl.getResponse();
            const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);

            if (response != null && response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
                const subscriptionId = response.getSubscriptionId();
                functions.logger.info(`SUCCESS: Authorize.Net subscription created: ${subscriptionId}`);

                try {
                    functions.logger.info(`Attempting to create user in Firebase Auth for: ${email}`);
                    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
                    functions.logger.info(`SUCCESS: User created in Firebase Auth: ${userRecord.uid}`);

                    await admin.firestore().collection("users").doc(userRecord.uid).set({
                        name: name,
                        email: email,
                        plan: planName,
                        authNetSubscriptionId: subscriptionId,
                        subscriptionStatus: "active",
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        isAdvisor: isAdvisor || false,
                        isAdmin: (email === "admin@simplifinance.com")
                    });
                    functions.logger.info(`SUCCESS: User data saved to Firestore for UID: ${userRecord.uid}`);
                    res.status(200).send({ status: 'success', userId: userRecord.uid });
                } catch (error) {
                    functions.logger.error('CRITICAL FAILURE: Payment succeeded but Firebase user creation failed.', error);
                    res.status(500).send({ error: 'Payment succeeded, but user account creation failed. Please contact support.' });
                }
            } else {
                const message = response.getMessages().getMessage()[0];
                const errorCode = message.getCode();
                const errorMessage = message.getText();
                functions.logger.error(`Authorize.Net transaction FAILED. Code: ${errorCode}, Message: ${errorMessage}`);
                res.status(400).send({ error: `Payment failed: ${errorMessage}` });
            }
        });
    } catch (error) {
        functions.logger.error("Unhandled error in createSubscription:", error);
        res.status(500).send({ error: 'Internal server error. Please try again later.' });
    }
});