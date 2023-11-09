import { mount } from "@vue/test-utils";
import { getLocalVue } from "tests/jest/helpers";

import Filtering from "@/utils/filtering";

import MountTarget from "./GridList.vue";

const localVue = getLocalVue();

const testGrid = {
    actions: [
        {
            title: "test",
            icon: "test-icon",
            handler: jest.fn(),
        },
    ],
    fields: [
        {
            key: "id",
            title: "id",
            type: "text",
        },
        {
            key: "link",
            title: "link",
            type: "link",
        },
    ],
    filtering: new Filtering({}, undefined, false, false),
    getData: jest.fn(() => {
        const data = [
            {
                id: "id-1",
                link: "link-1",
            },
            {
                id: "id-2",
                link: "link-2",
            },
        ];
        return [data, data.length];
    }),
    plural: "Tests",
    sortBy: "id",
    sortDesc: true,
    sortKeys: ["id"],
    title: "Test",
};

function createTarget(propsData) {
    return mount(MountTarget, {
        localVue,
        propsData,
        stubs: {
            Icon: true,
        },
    });
}

describe("GridList", () => {
    it("basic rendering", async () => {
        const wrapper = createTarget({
            config: testGrid,
        });
        const findInput = wrapper.find("[data-description='filter text input']");
        expect(findInput.attributes().placeholder).toBe("search tests");
        expect(wrapper.find(".loading-message").text()).toBe("Loading...");
        const findAction = wrapper.find("[data-description='grid action test']");
        expect(findAction.text()).toBe("test");
        await findAction.trigger("click");
        expect(testGrid.actions[0].handler).toHaveBeenCalledTimes(1);
        expect(testGrid.getData).toHaveBeenCalledTimes(1);
        expect(testGrid.getData.mock.calls[0]).toEqual([0, 25, "", "id", true]);
        expect(findAction.find("[icon='test-icon']").exists()).toBeTruthy();
        await wrapper.vm.$nextTick();
        expect(wrapper.find("[data-description='grid title']").text()).toBe("Test");
        expect(wrapper.find("[data-description='grid cell 0-0']").text()).toBe("id-1");
        expect(wrapper.find("[data-description='grid cell 1-0']").text()).toBe("id-2");
        expect(wrapper.find("[data-description='grid cell 0-1'] > a").text()).toBe("link-1");
        expect(wrapper.find("[data-description='grid cell 1-1'] > a").text()).toBe("link-2");
        const firstHeader = wrapper.find("[data-description='grid header 0']");
        expect(firstHeader.find("a").text()).toBe("id");
        await firstHeader.find("[data-description='grid sort asc']").trigger("click");
        expect(testGrid.getData).toHaveBeenCalledTimes(2);
        expect(testGrid.getData.mock.calls[1]).toEqual([0, 25, "", "id", false]);
        expect(firstHeader.find("[data-description='grid sort asc']").exists()).toBeFalsy();
        expect(firstHeader.find("[data-description='grid sort desc']").exists()).toBeTruthy();
        const secondHeader = wrapper.find("[data-description='grid header 1']");
        expect(secondHeader.find("[data-description='grid sort asc']").exists()).toBeFalsy();
        expect(secondHeader.find("[data-description='grid sort desc']").exists()).toBeFalsy();
    });
});
